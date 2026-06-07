// src/timeLogStats.js
//
// Pure data layer for the Time Log Analytics sub-tab (v1 snapshot).
// No React, no Firebase — takes the raw /timeLogs tree + /projects and
// returns plain aggregates. Kept pure so it's unit-testable with
// node:test (tests/timeLogStats.test.js) and reusable by the deferred
// v2 over-time trend.
//
// Design facts proven by scripts/timelog-coverage-audit.mjs against real
// data (2026-06-07):
//   - Cohort = a video (taskId) that JOINS a /projects subtask AND that
//     subtask is status==="done". Legacy numeric-id logs never join, so
//     this filter excludes them without needing the `source` field.
//   - Stage is written in mixed casing/spacing ("edit"/"Edit",
//     "revisions"/"Revisions") — normalise before filtering.
//   - Category comes from project.videoType via categorizeContent; a
//     blank videoType that falls through to "Other" is relabelled
//     "Uncategorized" (it's missing data, not a real "Other").

import { categorizeContent } from "./utils.js";

const SECS_PER_H = 3600;
const EDIT_STAGES = new Set(["edit", "revisions"]);

// "Edit" / "Pre Production" / "revisions" → "edit" / "preproduction" / "revisions"
export function normStage(stage) {
  return String(stage || "").toLowerCase().replace(/\s+/g, "");
}

// Category for a video. A blank videoType that classifies to "Other" is
// missing data → "Uncategorized" (distinct from a populated type that
// genuinely doesn't map, e.g. "Storyboard").
export function categoryOf(parentName, videoType) {
  const c = categorizeContent(parentName || "", videoType || "");
  if (c === "Other" && !String(videoType || "").trim()) return "Uncategorized";
  return c;
}

// UTC day index for a strict "YYYY-MM-DD" key — DST-safe, no local-time
// drift. Returns NaN for anything not exactly zero-padded YYYY-MM-DD or a
// date that doesn't exist (e.g. "2026-02-31" would normalise to March).
export function utcDay(dateKey) {
  const s = String(dateKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const [y, m, d] = s.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return NaN;
  return Math.floor(ms / 86400000);
}

// projects (array or keyed object) -> Map(subtaskId -> {status, videoType, parentName})
export function buildProjectIndex(projects) {
  const list = Array.isArray(projects) ? projects : Object.values(projects || {});
  const index = new Map();
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const parentName = `${p.clientName || "—"}: ${p.projectName || "Untitled project"}`;
    const videoType = p.videoType || "";
    const subs = p.subtasks ? Object.values(p.subtasks) : [];
    for (const st of subs) {
      if (!st || !st.id) continue;
      const next = { status: st.status || "unknown", videoType, parentName };
      const existing = index.get(st.id);
      // Subtask ids are globally unique (st-<ts>-<rand>), so a collision is
      // near-impossible — but if one ever happens, prefer the "done" entry so
      // a real completed video is never clobbered by an in-progress dup.
      if (!existing || (existing.status !== "done" && next.status === "done")) {
        index.set(st.id, next);
      }
    }
  }
  return index;
}

// allTimeLogs + index -> one fact row PER in-scope video (taskId).
// This is the single source of truth — every downstream denominator is
// derived from it, so edit/revision metrics can't drift apart.
export function buildVideoFacts(allTimeLogs, index) {
  const acc = new Map();
  for (const dates of Object.values(allTimeLogs || {})) {
    if (!dates || typeof dates !== "object") continue;
    for (const [dateKey, dayData] of Object.entries(dates)) {
      if (!dayData || typeof dayData !== "object") continue;
      if (Number.isNaN(utcDay(dateKey))) continue; // skip malformed date keys
      for (const [taskId, val] of Object.entries(dayData)) {
        if (taskId.startsWith("_")) continue; // _running etc.
        const meta = index.get(taskId);
        if (!meta || meta.status !== "done") continue; // cohort gate: join + done
        const stage = normStage(typeof val === "object" ? val?.stage : "");
        if (!EDIT_STAGES.has(stage)) continue;
        // Coerce: Firebase/imports sometimes store secs as a string, which
        // would otherwise string-concatenate into nonsense totals.
        const secs = Number(typeof val === "number" ? val : val?.secs);
        if (!Number.isFinite(secs) || secs <= 0) continue;
        let f = acc.get(taskId);
        if (!f) {
          f = {
            taskId,
            category: categoryOf(meta.parentName, meta.videoType),
            editSecs: 0,
            revisionSecs: 0,
            editDays: new Set(),
            lastLogDate: dateKey,
          };
          acc.set(taskId, f);
        }
        if (stage === "edit") {
          f.editSecs += secs;
          f.editDays.add(dateKey);
        } else {
          f.revisionSecs += secs; // "revisions"
        }
        if (dateKey > f.lastLogDate) f.lastLogDate = dateKey;
      }
    }
  }

  const facts = [];
  for (const f of acc.values()) {
    const editDates = [...f.editDays].filter((k) => !Number.isNaN(utcDay(k))).sort();
    const idx = editDates.map(utcDay);
    facts.push({
      taskId: f.taskId,
      category: f.category,
      editSecs: f.editSecs,
      revisionSecs: f.revisionSecs,
      hasEdit: f.editSecs > 0,
      hasRevision: f.revisionSecs > 0,
      editSpanDays: idx.length ? idx[idx.length - 1] - idx[0] : 0,
      // edit-completion anchor: the latest day this video had an edit log.
      editLastDate: editDates.length ? editDates[editDates.length - 1] : null,
      lastLogDate: f.lastLogDate,
    });
  }
  return facts;
}

// Monday (UTC) of the week containing dateKey, as "YYYY-MM-DD". null if bad.
export function weekStartKey(dateKey) {
  const d = utcDay(dateKey);
  if (Number.isNaN(d)) return null;
  const dow = new Date(d * 86400000).getUTCDay(); // 0=Sun..6=Sat
  return dayIdxToKey(d - ((dow + 6) % 7));
}

function dayIdxToKey(dayIdx) {
  const dt = new Date(dayIdx * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Continuous list of Monday keys from startKey..endKey inclusive.
function continuousWeeks(startKey, endKey) {
  const start = utcDay(startKey);
  const end = utcDay(endKey);
  const out = [];
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let d = start; d <= end; d += 7) out.push(dayIdxToKey(d));
  return out;
}

// Weekly time series of AVERAGE edit hours per video, one series per category.
// Each video is anchored on its edit-completion week (week of its last edit
// log). Weekly (not monthly) because the dataset is only weeks deep — monthly
// would be 1-2 points. Empty weeks emit null (a gap, not a fake 0).
export function buildWeeklySeries(facts) {
  const vids = facts.filter((f) => f.hasEdit && f.editLastDate);
  if (!vids.length) return { weeks: [], series: [] };

  const byWeekCat = new Map(); // `${week}|${cat}` -> {sum, n}
  const weekSet = new Set();
  const catN = new Map(); // category -> total videos (for ordering)
  for (const f of vids) {
    const wk = weekStartKey(f.editLastDate);
    if (!wk) continue;
    weekSet.add(wk);
    catN.set(f.category, (catN.get(f.category) || 0) + 1);
    const key = `${wk}|${f.category}`;
    const cur = byWeekCat.get(key) || { sum: 0, n: 0 };
    cur.sum += f.editSecs / 3600;
    cur.n += 1;
    byWeekCat.set(key, cur);
  }
  const sortedWeeks = [...weekSet].sort();
  const weeks = continuousWeeks(sortedWeeks[0], sortedWeeks[sortedWeeks.length - 1]);
  const categories = [...catN.keys()].sort((a, b) => catN.get(b) - catN.get(a) || a.localeCompare(b));
  const series = categories.map((category) => ({
    category,
    n: catN.get(category),
    points: weeks.map((wk, x) => {
      const cell = byWeekCat.get(`${wk}|${category}`);
      return { x, y: cell ? cell.sum / cell.n : null, n: cell ? cell.n : 0 };
    }),
  }));
  return { weeks, series };
}

// ─── stats helpers ───
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Nearest-rank quantile on an already-sorted array: the p-th quantile is the
// value at 1-based rank ceil(p*n) (0-based ceil(p*n)-1).
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function statBlock(vids) {
  const n = vids.length;
  const editH = vids.filter((v) => v.hasEdit).map((v) => v.editSecs / SECS_PER_H).sort((a, b) => a - b);
  const sumEditSecs = vids.reduce((s, v) => s + v.editSecs, 0);
  const sumRevSecs = vids.reduce((s, v) => s + v.revisionSecs, 0);
  const revisedN = vids.filter((v) => v.hasRevision).length;
  const p25 = quantile(editH, 0.25);
  const p75 = quantile(editH, 0.75);
  const iqr = p75 - p25;
  const outliers = editH.filter((h) => h > p75 + 1.5 * iqr).length;
  return {
    n,
    nEdit: editH.length,
    medianEditH: median(editH),
    meanEditH: mean(editH),
    min: editH.length ? editH[0] : 0,
    p25,
    p75,
    p90: quantile(editH, 0.9),
    max: editH.length ? editH[editH.length - 1] : 0,
    outliers,
    totalEditH: sumEditSecs / SECS_PER_H,
    totalRevisionH: sumRevSecs / SECS_PER_H,
    editHPerVideo: n ? sumEditSecs / n / SECS_PER_H : 0,
    revisionHPerVideo: n ? sumRevSecs / n / SECS_PER_H : 0,
    revisionRate: n ? revisedN / n : 0,
    // null = "n/a" rather than Infinity when a category has revision time
    // but no logged edit time (edit predates tracking).
    revisionBurden: sumEditSecs > 0 ? sumRevSecs / sumEditSecs : null,
    avgRevisionHAmongRevised: revisedN ? sumRevSecs / revisedN / SECS_PER_H : 0,
  };
}

// Per-category rows, sorted by sample size (n) desc.
export function summariseByCategory(facts) {
  const byCat = new Map();
  for (const f of facts) {
    if (!byCat.has(f.category)) byCat.set(f.category, []);
    byCat.get(f.category).push(f);
  }
  const rows = [];
  for (const [category, vids] of byCat.entries()) {
    rows.push({ category, ...statBlock(vids) });
  }
  rows.sort((a, b) => b.n - a.n);
  return rows;
}

// Overall KPI block + the date range that scopes it.
export function summariseOverall(facts) {
  const dates = facts.map((f) => f.lastLogDate).filter(Boolean).sort();
  return {
    ...statBlock(facts),
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
  };
}

// Period filter by lastLogDate. days falsy → unfiltered. refDateKey is the
// "today" anchor ("YYYY-MM-DD"); passed in so the function stays pure.
export function filterFactsByDays(facts, days, refDateKey) {
  if (!days) return facts;
  const ref = utcDay(refDateKey);
  if (Number.isNaN(ref)) return facts;
  return facts.filter((f) => {
    const d = utcDay(f.lastLogDate);
    return !Number.isNaN(d) && ref - d < days;
  });
}
