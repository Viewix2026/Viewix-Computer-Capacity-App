// Ugly-cases unit tests for the Phase 2 plan-apply pure core.
// Run via:  node shared/scheduling/__tests__/plan-apply.test.mjs
//
// Covers the Codex PR #148 P1 fixes in isolation: the claim state
// machine (P1 #1) and the idempotent reconcile + divergence detection
// (P1 #3). Same harness as planner.test.mjs / checker.test.mjs.

import assert from "node:assert/strict";
import {
  decideClaimOutcome,
  reconcilePlan,
  writeCounts,
} from "../plan-apply-core.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

const NOW = 1_700_000_000_000;
const mkId = (stage, vi) => `new_${stage}_${vi}`;

// ─── 1. decideClaimOutcome (P1 #1) ─────────────────────────────────

test("decideClaimOutcome: pending + not expired → ok", () => {
  assert.deepEqual(
    decideClaimOutcome({ status: "pending", expiresAt: NOW + 1000 }, NOW),
    { ok: true },
  );
});
test("decideClaimOutcome: pending + expired → not_pending/expired", () => {
  const d = decideClaimOutcome({ status: "pending", expiresAt: NOW - 1 }, NOW);
  assert.equal(d.ok, false);
  assert.equal(d.status, "not_pending");
  assert.equal(d.reason, "expired");
});
test("decideClaimOutcome: claimed (double-click) → not_pending/claimed", () => {
  const d = decideClaimOutcome({ status: "claimed", expiresAt: NOW + 1000 }, NOW);
  assert.deepEqual(d, { ok: false, status: "not_pending", reason: "claimed" });
});
test("decideClaimOutcome: cancelled → not_pending/cancelled", () => {
  const d = decideClaimOutcome({ status: "cancelled", expiresAt: NOW + 1000 }, NOW);
  assert.deepEqual(d, { ok: false, status: "not_pending", reason: "cancelled" });
});
test("decideClaimOutcome: approved → applied/already_applied", () => {
  const d = decideClaimOutcome({ status: "approved", expiresAt: NOW + 1000 }, NOW);
  assert.deepEqual(d, { ok: false, status: "applied", reason: "already_applied" });
});
test("decideClaimOutcome: approved + expired → still already_applied (approved wins)", () => {
  const d = decideClaimOutcome({ status: "approved", expiresAt: NOW - 99999 }, NOW);
  assert.deepEqual(d, { ok: false, status: "applied", reason: "already_applied" });
});
test("decideClaimOutcome: missing record → not_pending/missing", () => {
  assert.deepEqual(decideClaimOutcome(null, NOW),
    { ok: false, status: "not_pending", reason: "missing" });
  assert.deepEqual(decideClaimOutcome(undefined, NOW),
    { ok: false, status: "not_pending", reason: "missing" });
});
test("decideClaimOutcome: stale status → not_pending/stale", () => {
  const d = decideClaimOutcome({ status: "stale", expiresAt: NOW + 1000 }, NOW);
  assert.deepEqual(d, { ok: false, status: "not_pending", reason: "stale" });
});

// ─── 2. reconcilePlan — happy paths ────────────────────────────────

function ps(partial) {
  return {
    mode: "create", stage: "edit", videoIndex: 1, _videoIndex: 1,
    _existingSubtaskId: null,
    name: "Edit — Video 1", startDate: "2026-05-20", endDate: "2026-05-20",
    startTime: null, endTime: null, assigneeIds: ["ed-alex"], assigneeId: "ed-alex",
    ...partial,
  };
}

test("reconcilePlan: create-missing → CREATE with planGroup + order", () => {
  const r = reconcilePlan({
    projectId: "p", proposedSubtasks: [ps({})], liveSubtasks: {},
    planGroupId: "PG", nowIso: "2026-05-16T00:00:00.000Z", mkId,
  });
  assert.equal(r.diverged.length, 0);
  assert.deepEqual(r.written, [{ id: "new_edit_1", action: "create" }]);
  const row = r.updates["/projects/p/subtasks/new_edit_1"];
  assert.equal(row.stage, "edit");
  assert.equal(row._planGroupId, "PG");
  assert.equal(row._videoIndex, 1);
  assert.equal(row.order, 1);
  assert.equal(row.source, "slack-plan");
});

test("reconcilePlan: update unscheduled in place reuses id, no duplicate", () => {
  const live = {
    old1: { id: "old1", stage: "edit", _videoIndex: 1, status: "scheduled",
      startDate: null, order: 5 },
  };
  const r = reconcilePlan({
    projectId: "p",
    proposedSubtasks: [ps({ mode: "update", _existingSubtaskId: "old1" })],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 0);
  assert.deepEqual(r.written, [{ id: "old1", action: "update" }]);
  assert.equal(r.updates["/projects/p/subtasks/old1/startDate"], "2026-05-20");
  assert.equal(r.updates["/projects/p/subtasks/old1/_planGroupId"], "PG");
  // No CREATE row was emitted.
  assert.ok(!Object.keys(r.updates).some(k => k.includes("new_edit_")));
});

test("reconcilePlan: revisions skip-if-exists", () => {
  const live = { r2: { id: "r2", stage: "revisions", _videoIndex: 2 } };
  const r = reconcilePlan({
    projectId: "p",
    proposedSubtasks: [ps({ stage: "revisions", videoIndex: 2, _videoIndex: 2,
      name: "Revisions — Video 2", startDate: null, endDate: null })],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 0);
  assert.deepEqual(r.written, [{ id: "r2", action: "skip-revision-exists" }]);
  assert.equal(Object.keys(r.updates).length, 0);
});

test("reconcilePlan: unindexed/manual live subtask is ignored, not clobbered", () => {
  const live = {
    manual: { id: "manual", stage: "edit", name: "Director cut",
      status: "scheduled", startDate: "2026-05-15" },
  };
  const r = reconcilePlan({
    projectId: "p", proposedSubtasks: [ps({})], liveSubtasks: live,
    planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 0, "manual unindexed row must not count as a divergence");
  assert.deepEqual(r.written, [{ id: "new_edit_1", action: "create" }]);
  assert.ok(!Object.keys(r.updates).some(k => k.includes("/manual")));
});

test("reconcilePlan: archived keyed row ignored → creates fresh", () => {
  const live = {
    arch: { id: "arch", stage: "edit", _videoIndex: 1, status: "archived",
      startDate: "2026-05-10" },
  };
  const r = reconcilePlan({
    projectId: "p", proposedSubtasks: [ps({})], liveSubtasks: live,
    planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 0);
  assert.deepEqual(r.written, [{ id: "new_edit_1", action: "create" }]);
});

// ─── 3. reconcilePlan — divergence (P1 #3) ─────────────────────────

test("reconcilePlan: create-target now scheduled → diverged, writes nothing", () => {
  const live = {
    x: { id: "x", stage: "edit", _videoIndex: 1, startDate: "2026-05-18" },
  };
  const r = reconcilePlan({
    projectId: "p", proposedSubtasks: [ps({ mode: "create" })],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 1);
  assert.equal(r.diverged[0].reason, "create_target_now_scheduled");
  assert.equal(Object.keys(r.updates).length, 0);
  assert.equal(r.written.length, 0);
});

test("reconcilePlan: update-target gained a startDate → diverged", () => {
  const live = {
    old1: { id: "old1", stage: "edit", _videoIndex: 1, startDate: "2026-05-19" },
  };
  const r = reconcilePlan({
    projectId: "p",
    proposedSubtasks: [ps({ mode: "update", _existingSubtaskId: "old1" })],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged[0].reason, "update_target_now_scheduled");
  assert.equal(Object.keys(r.updates).length, 0);
});

test("reconcilePlan: update-target replaced by a different row → diverged", () => {
  const live = {
    other: { id: "other", stage: "edit", _videoIndex: 1, startDate: null },
  };
  const r = reconcilePlan({
    projectId: "p",
    proposedSubtasks: [ps({ mode: "update", _existingSubtaskId: "old1" })],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged[0].reason, "update_target_replaced");
  assert.equal(Object.keys(r.updates).length, 0);
});

test("reconcilePlan: mixed — one diverged blocks-reports, others still computed", () => {
  // The wrapper refuses the whole apply if diverged is non-empty; this
  // just asserts reconcile reports per-row correctly without throwing.
  const live = {
    sched1: { id: "sched1", stage: "edit", _videoIndex: 1, startDate: "2026-05-18" },
  };
  const r = reconcilePlan({
    projectId: "p",
    proposedSubtasks: [
      ps({ mode: "create", videoIndex: 1, _videoIndex: 1 }),                 // diverged
      ps({ mode: "create", videoIndex: 2, _videoIndex: 2, name: "Edit — Video 2" }), // creatable
    ],
    liveSubtasks: live, planGroupId: "PG", nowIso: "ISO", mkId,
  });
  assert.equal(r.diverged.length, 1);
  assert.equal(r.diverged[0].key, "edit|1");
  assert.ok(r.written.some(w => w.id === "new_edit_2" && w.action === "create"));
});

// ─── 4. determinism + counts ───────────────────────────────────────

test("reconcilePlan: deterministic for same inputs", () => {
  const args = {
    projectId: "p",
    proposedSubtasks: [ps({ videoIndex: 1, _videoIndex: 1 }),
      ps({ videoIndex: 2, _videoIndex: 2, name: "Edit — Video 2" })],
    liveSubtasks: {}, planGroupId: "PG", nowIso: "ISO", mkId,
  };
  assert.equal(JSON.stringify(reconcilePlan(args)), JSON.stringify(reconcilePlan(args)));
});

test("writeCounts: tallies create/update/skip", () => {
  const c = writeCounts([
    { action: "create" }, { action: "create" },
    { action: "update" },
    { action: "skip-revision-exists" },
  ]);
  assert.deepEqual(c, { created: 2, updated: 1, skipped: 1 });
});

console.log(`\n${passed} tests passed`);
