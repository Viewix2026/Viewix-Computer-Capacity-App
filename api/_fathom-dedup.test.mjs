// Unit tests for api/_fathom-dedup.js — stable feedbackId derivation.
// Run via:  node api/_fathom-dedup.test.mjs
// Same convention as the other suites — no test runner, assertions throw.

import assert from "node:assert/strict";
import { deriveFeedbackId } from "./_fathom-dedup.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const base = {
  recordingUrl: "https://fathom.video/calls/12345",
  meetingName: "Discovery - Acme Corp",
  transcript: "hello ".repeat(50),
};

test("same payload → same id (retry lands on the same record)", () => {
  assert.equal(deriveFeedbackId(base), deriveFeedbackId({ ...base }));
});

test("id shape is mf-<12 hex>", () => {
  assert.match(deriveFeedbackId(base), /^mf-[0-9a-f]{12}$/);
});

test("recordingUrl dominates: transcript/meeting changes don't alter the id", () => {
  assert.equal(
    deriveFeedbackId(base),
    deriveFeedbackId({ ...base, meetingName: "Renamed", transcript: "different ".repeat(40) })
  );
});

test("different recordingUrl → different id", () => {
  assert.notEqual(deriveFeedbackId(base), deriveFeedbackId({ ...base, recordingUrl: "https://fathom.video/calls/99999" }));
});

test("fallback path (no url) is stable and sensitive to transcript shape", () => {
  const noUrl = { meetingName: "Discovery - Acme", transcript: "abc ".repeat(100) };
  assert.equal(deriveFeedbackId(noUrl), deriveFeedbackId({ ...noUrl }));
  assert.notEqual(deriveFeedbackId(noUrl), deriveFeedbackId({ ...noUrl, transcript: "xyz " + "abc ".repeat(100) }));
  assert.notEqual(deriveFeedbackId(noUrl), deriveFeedbackId({ ...noUrl, meetingName: "Catchup - Acme" }));
});

test("fallback hashes the FULL transcript — same name/length/prefix must not collide", () => {
  // Templated recordings: identical 300-char opening, divergent tails,
  // equal total length. A prefix+length hash collided here and dropped
  // the second meeting as a duplicate.
  const opening = "intro ".repeat(50); // 300 chars
  const a = { meetingName: "Weekly Template", transcript: opening + "alpha content tail" };
  const b = { meetingName: "Weekly Template", transcript: opening + "bravo different t." };
  assert.equal(a.transcript.length, b.transcript.length);
  assert.notEqual(deriveFeedbackId(a), deriveFeedbackId(b));
});

test("whitespace-only url falls back rather than hashing emptiness", () => {
  const a = deriveFeedbackId({ ...base, recordingUrl: "  " });
  const b = deriveFeedbackId({ ...base, recordingUrl: "" });
  assert.equal(a, b);
});

console.log(`\n${passed} passed`);
