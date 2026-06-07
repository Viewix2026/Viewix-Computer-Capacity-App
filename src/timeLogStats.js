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
    const idx = [...f.editDays].map(utcDay).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    facts.push({
      taskId: f.taskId,
      category: f.category,
      editSecs: f.editSecs,
      revisionSecs: f.revisionSecs,
      hasEdit: f.editSecs > 0,
      hasRevision: f.revisionSecs > 0,
      editSpanDays: idx.length ? idx[idx.length - 1] - idx[0] : 0,
      lastLogDate: f.lastLogDate,
    });
  }
  return facts;
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
