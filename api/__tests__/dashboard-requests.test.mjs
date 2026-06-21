// Pure unit tests for the Dashboard Requests helpers.
// Run via:  node --test api/__tests__/dashboard-requests.test.mjs
// No test runner needed beyond node:test — assertions throw on failure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTicket, validId, newRequestId, ticketIdForThread, buildIssueBody } from "../_dashboard-requests.js";
import { referencedIssues, closingReferences } from "../github-request-webhook.js";
import { toSlackMrkdwn } from "../_dashboard-intake.js";
import { parseButtonValue } from "../slack-request-interactivity.js";

test("toSlackMrkdwn converts **bold** to Slack *bold*", () => {
  assert.equal(toSlackMrkdwn("**Which tab** is slow?"), "*Which tab* is slow?");
  assert.equal(toSlackMrkdwn("no markup here"), "no markup here");
  assert.equal(toSlackMrkdwn("**a** and **b**"), "*a* and *b*");
  assert.equal(toSlackMrkdwn(null), "");
});

test("parseButtonValue accepts rootTs::round::opt, rejects malformed/forged", () => {
  assert.deepEqual(parseButtonValue("1718000000.123456::2::0"), { rootTs: "1718000000.123456", roundIndex: 2, optIndex: 0 });
  assert.equal(parseButtonValue("1718000000.123456::2"), null, "missing optIndex");
  assert.equal(parseButtonValue("a::b::c"), null, "non-numeric indices");
  assert.equal(parseButtonValue("::1::0"), null, "empty rootTs");
  assert.equal(parseButtonValue("ts::-1::0"), null, "negative round rejected");
  assert.equal(parseButtonValue(""), null);
  assert.equal(parseButtonValue(null), null);
  assert.equal(parseButtonValue("ts::1::0::extra"), null, "too many parts");
});

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

test("closingReferences matches only explicit closing keywords, not bare mentions", () => {
  assert.deepEqual(closingReferences("Fixes #12 and closes #13"), [12, 13]);
  assert.deepEqual(closingReferences("resolved #7, resolve #7"), [7], "keyword variants de-duped");
  assert.deepEqual(closingReferences("see #42 for context, related to #43"), [], "bare mentions ignored");
  assert.deepEqual(closingReferences("closes: #9"), [9], "colon form accepted");
  assert.deepEqual(closingReferences("closed #5\nfixed #6"), [5, 6]);
  assert.deepEqual(closingReferences(""), []);
});

test("ticketIdForThread is deterministic and validId-safe", () => {
  const a = ticketIdForThread("1718000000.123456");
  assert.equal(a, "req_1718000000_123456");
  assert.equal(a, ticketIdForThread("1718000000.123456"), "same thread → same id (idempotent create)");
  assert.ok(validId(a), "derived id must pass validId");
  assert.equal(validId("req_1718000000.123456"), null, "raw ts (with dot) would be an invalid RTDB key");
});

test("buildIssueBody escapes markdown so user text can't restructure the build brief", () => {
  const t = buildTicket({
    id: "req_1_aaaaaaaa", title: "t", type: "bug",
    body: "### NotAHeading\n[x](http://evil)",
    clarifications: [{ q: "where?", a: "`code` and ](http://evil)" }],
    screenshots: [{ permalink: "https://example.com/s", name: "evil](http://x)" }],
  });
  const md = buildIssueBody(t);
  assert.ok(!/^### NotAHeading$/m.test(md), "a leading heading marker must be escaped");
  assert.ok(md.includes("\\#"), "hash escaped");
  assert.ok(md.includes("evil\\]"), "screenshot filename bracket escaped (no link breakout)");
  assert.ok(md.includes("(https://example.com/s)"), "trusted Slack permalink preserved verbatim");
});

test("buildIssueBody escapes raw HTML so injected tags don't render in the issue", () => {
  const t = buildTicket({
    id: "req_2_bbbbbbbb", title: "t", type: "bug",
    body: "<img src=x onerror=alert(1)>\n<!-- hide --> rest",
  });
  const md = buildIssueBody(t);
  // Every `<` must be backslash-escaped — GitHub renders `\<img>` as literal
  // text, never an HTML element, so no raw tag/comment can survive.
  assert.ok(!/(?<!\\)</.test(md), "no unescaped < may reach the issue body");
  assert.ok(md.includes("\\<img"), "the injected tag is present only in escaped form");
});
