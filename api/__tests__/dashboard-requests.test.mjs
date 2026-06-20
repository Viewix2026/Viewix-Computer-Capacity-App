// Pure unit tests for the Dashboard Requests helpers.
// Run via:  node --test api/__tests__/dashboard-requests.test.mjs
// No test runner needed beyond node:test — assertions throw on failure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTicket, validId, newRequestId } from "../_dashboard-requests.js";
import { referencedIssues } from "../github-request-webhook.js";

test("validId accepts the minting charset, rejects path-injection", () => {
  assert.ok(validId("req_1718000000000_deadbeef"));
  assert.ok(validId("abc-123_XYZ"));
  assert.equal(validId("foo/createdAt"), null, "slash must be rejected");
  assert.equal(validId("a.b"), null, "dot must be rejected");
  assert.equal(validId("a#b"), null);
  assert.equal(validId(""), null);
  assert.equal(validId("x".repeat(121)), null, "over length cap rejected");
  assert.equal(validId(null), null);
  assert.equal(validId(123), null);
});

test("newRequestId is self-consistent with validId", () => {
  for (let i = 0; i < 50; i++) assert.ok(validId(newRequestId()), "minted id must pass validId");
});

test("buildTicket always lands at triage with server-owned shape", () => {
  const t = buildTicket({ id: "req_1_aaaaaaaa", title: "Fix the thing", type: "bug", source: "slack" });
  assert.equal(t.status, "triage", "new tickets always start in triage");
  assert.equal(t.type, "bug");
  assert.equal(t.source, "slack");
  assert.equal(t.priority, null);
  assert.equal(t.plan, null);
  assert.equal(t.github, null);
  assert.deepEqual(t.screenshots, []);
  assert.deepEqual(t.clarifications, []);
  assert.equal(typeof t.createdAt, "number");
  assert.equal(t.createdAt, t.updatedAt);
});

test("buildTicket sanitizes type/priority/source and clamps long input", () => {
  const t = buildTicket({
    id: "x", title: "y".repeat(500), body: "z".repeat(9000),
    type: "nonsense", priority: "urgent", source: "evil",
    screenshots: new Array(40).fill({ permalink: "p", name: "n" }),
    clarifications: new Array(40).fill({ q: "q", a: "a" }),
  });
  assert.equal(t.type, "bug", "unknown type falls back to bug");
  assert.equal(t.priority, null, "unknown priority becomes null");
  assert.equal(t.source, "manual", "unknown source falls back to manual");
  assert.equal(t.title.length, 200, "title clamped to 200");
  assert.equal(t.body.length, 8000, "body clamped to 8000");
  assert.equal(t.screenshots.length, 20, "screenshots capped at 20");
  assert.equal(t.clarifications.length, 20, "clarifications capped at 20");
});

test("buildTicket tolerates a blank title and non-string body", () => {
  const t = buildTicket({ id: "x", title: "", body: null, type: "feature" });
  assert.equal(t.title, "Untitled request");
  assert.equal(t.body, "");
  assert.equal(t.type, "feature");
});

test("referencedIssues parses and de-dupes #N from PR text", () => {
  assert.deepEqual(referencedIssues("closes #12 and fixes #12, also #34"), [12, 34]);
  assert.deepEqual(referencedIssues("no refs here"), []);
  assert.deepEqual(referencedIssues("#1 #2 #3"), [1, 2, 3]);
  assert.deepEqual(referencedIssues(""), []);
});
