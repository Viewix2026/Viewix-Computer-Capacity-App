// Unit tests for api/_fathom-detect.js — salesperson detection.
// Run via:  node api/_fathom-detect.test.mjs
// Same convention as the other suites — no test runner, assertions throw.

import assert from "node:assert/strict";
import { detectSalesperson, detectSalespersonFromTranscript } from "./_fathom-detect.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ---- detectSalesperson (metadata) ----

test("detects from invitee objects", () => {
  assert.equal(detectSalesperson([{ name: "Brandon Lee" }, { name: "Some Client" }], "Catchup"), "Brandon");
});

test("detects from Fathom-native recorded_by", () => {
  assert.equal(detectSalesperson([], "Catchup", { recordedBy: { name: "Jeremy Farrugia", email: "jeremy@viewix.com.au" } }), "Jeremy");
});

test("detects from Fathom-native calendar_invitees", () => {
  assert.equal(detectSalesperson(null, "Catchup", { calendarInvitees: [{ email: "brandon@viewix.com.au" }] }), "Brandon");
});

test("empty metadata → empty string", () => {
  assert.equal(detectSalesperson([], "Viewix & Transport Heritage NSW", {}), "");
});

// ---- detectSalespersonFromTranscript ----

const fathomTranscript = `00:00:00 - Harry Stranger
      So going to start by saying we're not an easy client.
00:00:09 - Sophie Bryce
      I'm not sure about that.
00:00:12 - Jeremy Farrugia (Viewix)
      No, no, you're better than you think.
00:00:31 - Jeremy Farrugia (Viewix)
      All right, well, I'll take that.`;

test("detects salesperson from timestamped speaker labels", () => {
  assert.equal(detectSalespersonFromTranscript(fathomTranscript), "Jeremy");
});

test("dominant speaker wins when both salespeople are on the call", () => {
  const t = `00:00:00 - Brandon Lee (Viewix)
      Intro.
00:00:05 - Brandon Lee (Viewix)
      More talking.
00:00:09 - Jeremy Farrugia (Viewix)
      Quick hello.`;
  assert.equal(detectSalespersonFromTranscript(t), "Brandon");
});

test("client sharing a salesperson first name does not win over (Viewix)-tagged staff", () => {
  const t = `00:00:00 - Jeremy Clientson
      Hi.
00:00:03 - Jeremy Clientson
      We're keen.
00:00:06 - Jeremy Clientson
      Very keen.
00:00:09 - Brandon Lee (Viewix)
      Great.`;
  assert.equal(detectSalespersonFromTranscript(t), "Brandon");
});

test("untagged transcripts still detect by raw speaker name", () => {
  const t = `00:00:00 - Brandon
      Hello.
00:00:04 - Client Person
      Hi.`;
  assert.equal(detectSalespersonFromTranscript(t), "Brandon");
});

test("no salesperson in transcript → empty string", () => {
  const t = `00:00:00 - Alice
      Hello.
00:00:04 - Bob
      Hi.`;
  assert.equal(detectSalespersonFromTranscript(t), "");
});

test("empty / missing transcript → empty string", () => {
  assert.equal(detectSalespersonFromTranscript(""), "");
  assert.equal(detectSalespersonFromTranscript(null), "");
});

test("plain prose mention of a name does not count without a speaker label", () => {
  assert.equal(detectSalespersonFromTranscript("We should ask Jeremy about pricing sometime."), "");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
