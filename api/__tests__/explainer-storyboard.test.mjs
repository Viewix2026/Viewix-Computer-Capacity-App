// node --test api/__tests__/explainer-storyboard.test.mjs
// Covers normalizeStoryboard — the trust boundary that coerces Claude's JSON
// into a bounded, well-typed storyboard. Pure logic; no network, no Firebase.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeStoryboard } from "../_explainerStoryboard.js";

const good = {
  title: "The Slow Fall of the Dollar",
  visualSystem: { background: "muted parchment world map", palette: "ink + red", fonts: "DM Sans", treatment: "halftone cutouts, red marker stroke" },
  scenes: [
    { beat: "Open", voiceover: "The empire didn't fall in a war.", midground: "Trump cutout", foreground: "White House", midgroundPrompt: "b&w halftone Trump, transparent", foregroundPrompt: "White House line art", durationSec: 4 },
    { beat: "Turn", voiceover: "It fell to a bill it couldn't pay.", midground: "tanker", foreground: "oil chart", midgroundPrompt: "b&w tanker", foregroundPrompt: "rising chart", durationSec: 5 },
  ],
};

test("parses a clean object and computes derived fields", () => {
  const sb = normalizeStoryboard(good);
  assert.equal(sb.title, "The Slow Fall of the Dollar");
  assert.equal(sb.sceneCount, 2);
  assert.equal(sb.totalSec, 9);
  assert.equal(sb.scenes[0].n, 1);
  assert.equal(sb.scenes[1].n, 2);
  assert.equal(sb.visualSystem.background, "muted parchment world map");
});

test("parses a JSON string, stripping ```json fences", () => {
  const sb = normalizeStoryboard("```json\n" + JSON.stringify(good) + "\n```");
  assert.equal(sb.sceneCount, 2);
});

test("extracts the JSON object when the model wraps it in prose", () => {
  const sb = normalizeStoryboard("Here is your storyboard:\n" + JSON.stringify(good) + "\nHope that helps!");
  assert.equal(sb.sceneCount, 2);
  assert.equal(sb.title, good.title);
});

test("accepts narration/title aliases for voiceover/beat", () => {
  const sb = normalizeStoryboard({ scenes: [{ title: "Hook", narration: "Line one", durationSec: 3 }] });
  assert.equal(sb.scenes[0].beat, "Hook");
  assert.equal(sb.scenes[0].voiceover, "Line one");
});

test("drops empty rows and rejects a fully empty storyboard", () => {
  const sb = normalizeStoryboard({ scenes: [{ voiceover: "keep" }, { midground: "no voiceover or beat" }, {}] });
  assert.equal(sb.sceneCount, 1);
  assert.throws(() => normalizeStoryboard({ scenes: [{}, { foreground: "x" }] }), /empty/i);
});

test("clamps scene count to the 24 ceiling", () => {
  const many = { scenes: Array.from({ length: 40 }, (_, i) => ({ voiceover: `line ${i}`, durationSec: 1 })) };
  assert.equal(normalizeStoryboard(many).sceneCount, 24);
});

test("coerces bad durations to a sane default and bounds", () => {
  const sb = normalizeStoryboard({ scenes: [
    { voiceover: "a", durationSec: "not a number" },
    { voiceover: "b", durationSec: -5 },
    { voiceover: "c", durationSec: 999 },
    { voiceover: "d", durationSec: 0.4 },
  ] });
  assert.equal(sb.scenes[0].durationSec, 4);   // NaN -> default
  assert.equal(sb.scenes[1].durationSec, 4);   // non-positive -> default
  assert.equal(sb.scenes[2].durationSec, 20);  // clamped down to max
  assert.equal(sb.scenes[3].durationSec, 1);   // positive-but-tiny clamped up to min
});

test("clamps overlong fields and ignores non-string field types", () => {
  const sb = normalizeStoryboard({ scenes: [{ voiceover: "x".repeat(5000), beat: 12345, foreground: { nope: true } }] });
  assert.ok(sb.scenes[0].voiceover.length <= 1200);
  assert.equal(sb.scenes[0].beat, "");        // number -> ""
  assert.equal(sb.scenes[0].foreground, "");  // object -> ""
});

test("tolerates a missing visualSystem and non-array scenes", () => {
  assert.throws(() => normalizeStoryboard({ title: "t" }), /empty/i); // no scenes at all
  const sb = normalizeStoryboard({ scenes: [{ voiceover: "hi" }] });
  assert.equal(sb.visualSystem.background, "");
});

test("rejects unparseable input", () => {
  assert.throws(() => normalizeStoryboard("this is not json at all"), /usable storyboard/i);
  assert.throws(() => normalizeStoryboard(null), /usable storyboard/i);
  assert.throws(() => normalizeStoryboard(42), /usable storyboard/i);
});
