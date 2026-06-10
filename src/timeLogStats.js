// src/timeLogStats.js
//
// Pure data layer for the Time Log Analytics sub-tab: the weekly over-time
// trend (buildWeeklySeries) plus the snapshot aggregates (summarise*), with
// the paid-hours allocation model (computeDailyAllocations).
// No React, no Firebase — takes the raw /timeLogs tree + /projects and
// returns plain aggregates. Kept pure so it's unit-testable with
// node:test (tests/timeLogStats.test.js).
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
export const PAID_DAY_SECS = 8 * SECS_PER_H; // editors are paid 8h/day

// Per-task allocated EDIT seconds: the unlogged-but-paid time redistributed
// onto the tasks an editor actually worked. Editors underreport, so for each
// (editor, day) we take gap = max(0, 8h − total logged that day) — across ALL
// stages, so a shoot-heavy day doesn't create a fake editing gap — and split
// it EVENLY across the distinct tasks worked that day (gap ÷ tasks).
//
// Stage attribution: a share only COUNTS when that day's log for the task was
// an edit-stage log. Revision/shoot/preprod-day shares are dropped, not
// re-booked — adjusted "edit" hours must never absorb a revision day's gap
// (it would inflate edit medians and retroactively move historical chart
// points, since the weekly line anchors on the last EDIT day). Revision
// metrics stay deliberately logged-based. Non-edit tasks still dilute the
// denominator: the editor's gap genuinely spread across everything worked.
//
// A task accrues edit-day shares across every day it was touched. Total
// allocated never exceeds the 8h paid. Returns Map(taskId -> allocatedEditSecs).
export function computeDailyAllocations(allTimeLogs) {
  const alloc = new Map();
  for (const dates of Object.values(allTimeLogs || {})) {
    if (!dates || typeof dates !== "object") continue;
    for (const [dateKey, dayData] of Object.entries(dates)) {
      if (!dayData || typeof dayData !== "object") continue;
      if (Number.isNaN(utcDay(dateKey))) continue;
      let totalLogged = 0;
      const tasks = [];
      for (const [taskId, val] of Object.entries(dayData)) {
        if (taskId.startsWith("_")) continue;
        const secs = Number(typeof val === "number" ? val : val?.secs);
        if (!Number.isFinite(secs) || secs <= 0) continue;
        totalLogged += secs;
        const stage = normStage(typeof val === "object" ? val?.stage : "");
        tasks.push({ taskId, isEdit: stage === "edit" }); // dayData keys are unique → distinct tasks
      }
      const gap = Math.max(0, PAID_DAY_SECS - totalLogged);
      if (!tasks.length || gap <= 0) continue;
      const share = gap / tasks.length;
      for (const t of tasks) {
        if (t.isEdit) alloc.set(t.taskId, (alloc.get(t.taskId) || 0) + share);
      }
    }
  }
  return alloc;
}

// Edit seconds for a video under the chosen mode: logged edit time, plus its
// edit-day share of unlogged paid hours when adjusted.
function editSecsOf(v, adjusted) {
  return v.editSecs + (adjusted ? (v.allocatedEditSecs || 0) : 0);
}

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

// projects (array or keyed object) -> Map(subtaskId -> {status, videoType, parentName, name})
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
      const next = { status: st.status || "unknown", videoType, parentName, name: st.name || "" };
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
export function buildVideoFacts(allTimeLogs, index, allocations) {
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
            parentName: meta.parentName,
            videoName: meta.name || "",
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
      parentName: f.parentName,
      videoName: f.videoName,
      editSecs: f.editSecs,
      revisionSecs: f.revisionSecs,
      hasEdit: f.editSecs > 0,
      hasRevision: f.revisionSecs > 0,
      // Edit-day share of unlogged paid time for this task (0 if not supplied).
      allocatedEditSecs: allocations ? (allocations.get(f.taskId) || 0) : 0,
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

// Weekly time series of MEDIAN edit hours per video, one series per category.
// Median (not mean) so the line is robust to the few tasks that absorb a large
// paid-hours allocation on a light/half day — those outliers no longer drag the
// trend. Each video is anchored on its edit-completion week (week of its last
// edit log). Weekly (not monthly) because the dataset is only weeks deep.
// Empty weeks emit null (a gap, not a fake 0).
export function buildWeeklySeries(facts, adjusted = false) {
  const vids = facts.filter((f) => f.hasEdit && f.editLastDate);
  if (!vids.length) return { weeks: [], series: [] };

  const byWeekCat = new Map(); // `${week}|${cat}` -> number[] (per-video edit hours)
  const weekSet = new Set();
  const catN = new Map(); // category -> total videos (for ordering)
  for (const f of vids) {
    const wk = weekStartKey(f.editLastDate);
    if (!wk) continue;
    weekSet.add(wk);
    catN.set(f.category, (catN.get(f.category) || 0) + 1);
    const key = `${wk}|${f.category}`;
    const arr = byWeekCat.get(key) || [];
    arr.push(editSecsOf(f, adjusted) / SECS_PER_H);
    byWeekCat.set(key, arr);
  }
  const sortedWeeks = [...weekSet].sort();
  const weeks = continuousWeeks(sortedWeeks[0], sortedWeeks[sortedWeeks.length - 1]);
  const categories = [...catN.keys()].sort((a, b) => catN.get(b) - catN.get(a) || a.localeCompare(b));
  const series = categories.map((category) => ({
    category,
    n: catN.get(category),
    points: weeks.map((wk, x) => {
      const arr = byWeekCat.get(`${wk}|${category}`);
      return { x, y: arr && arr.length ? median([...arr].sort((a, b) => a - b)) : null, n: arr ? arr.length : 0 };
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

// `adjusted` switches the EDIT-time metrics (median/mean/five-number/per-video)
// to include allocated unlogged hours. Revision metrics stay logged-based —
// they're a structural edit:revision ratio that allocation doesn't inform — so
// revisionBurden uses LOGGED edit secs regardless of mode.
function statBlock(vids, adjusted = false) {
  const n = vids.length;
  // Edit sums are over EDIT videos only — a revision-only video carries an
  // allocated share but no logged edit (hasEdit=false), and must not leak its
  // allocation into adjusted edit totals.
  const editVids = vids.filter((v) => v.hasEdit);
  const editH = editVids.map((v) => editSecsOf(v, adjusted) / SECS_PER_H).sort((a, b) => a - b);
  const sumEditAdj = editVids.reduce((s, v) => s + editSecsOf(v, adjusted), 0);
  const sumEditLogged = editVids.reduce((s, v) => s + v.editSecs, 0);
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
    totalEditH: sumEditAdj / SECS_PER_H,
    totalRevisionH: sumRevSecs / SECS_PER_H,
    editHPerVideo: n ? sumEditAdj / n / SECS_PER_H : 0,
    // always-logged edit per video — used where it must stay coherent with the
    // logged-based revision burden ratio, regardless of the adjusted toggle.
    editHPerVideoLogged: n ? sumEditLogged / n / SECS_PER_H : 0,
    revisionHPerVideo: n ? sumRevSecs / n / SECS_PER_H : 0,
    revisionRate: n ? revisedN / n : 0,
    // null = "n/a" rather than Infinity when a category has revision time
    // but no logged edit time. Always logged-based (structural ratio).
    revisionBurden: sumEditLogged > 0 ? sumRevSecs / sumEditLogged : null,
    avgRevisionHAmongRevised: revisedN ? sumRevSecs / revisedN / SECS_PER_H : 0,
  };
}

// Per-category rows, sorted by sample size (n) desc.
export function summariseByCategory(facts, adjusted = false) {
  const byCat = new Map();
  for (const f of facts) {
    if (!byCat.has(f.category)) byCat.set(f.category, []);
    byCat.get(f.category).push(f);
  }
  const rows = [];
  for (const [category, vids] of byCat.entries()) {
    rows.push({ category, ...statBlock(vids, adjusted) });
  }
  rows.sort((a, b) => b.n - a.n);
  return rows;
}

// Overall KPI block + the date range that scopes it.
export function summariseOverall(facts, adjusted = false) {
  const dates = facts.map((f) => f.lastLogDate).filter(Boolean).sort();
  return {
    ...statBlock(facts, adjusted),
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
