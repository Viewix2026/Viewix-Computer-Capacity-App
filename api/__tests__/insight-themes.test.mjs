// node --test api/__tests__/insight-themes.test.mjs
// Covers the canonical-theme layer: taxonomy invariants, the classifier
// output contract (validateClassifierOutput), and the theme fallback on
// new-item creation paths. Pure logic only — no network, no Firebase.

import { test } from "node:test";
import assert from "node:assert/strict";

import { THEMES, OTHER_KEY, validTheme, themeLabel } from "../../src/lib/insightThemes.js";
import { validateClassifierOutput, EXTRACTION_SYSTEM_PROMPT, CLASSIFY_SYSTEM_PROMPT } from "../_transcript-insights.js";

const TYPES = ["objection", "painPoint", "contentIdea"];

// ─── Taxonomy invariants ─────────────────────────────────────────────

test("every type has themes with unique keys, labels and blurbs", () => {
  for (const type of TYPES) {
    const list = THEMES[type];
    assert.ok(Array.isArray(list) && list.length >= 8, `${type} has ≥8 themes`);
    const keys = new Set();
    for (const t of list) {
      assert.ok(t.key && typeof t.key === "string", `${type} theme has key`);
      assert.ok(!keys.has(t.key), `${type} duplicate key ${t.key}`);
      keys.add(t.key);
      assert.ok(t.label, `${type}:${t.key} has label`);
      assert.ok(t.blurb && t.blurb.length > 40, `${type}:${t.key} blurb is a real decision rule`);
      assert.notEqual(t.key, OTHER_KEY, `"${OTHER_KEY}" must not be a listed theme`);
    }
  }
});

test("validTheme accepts per-type keys and OTHER_KEY, rejects cross-type and junk", () => {
  assert.ok(validTheme("objection", "money"));
  assert.ok(validTheme("painPoint", "measurement"));
  assert.ok(validTheme("contentIdea", "hooks-formats"));
  assert.ok(validTheme("objection", OTHER_KEY));
  // money is an objection theme, not a painPoint theme
  assert.equal(validTheme("painPoint", "money"), false);
  assert.equal(validTheme("objection", "not-a-theme"), false);
  assert.equal(validTheme("objection", ""), false);
  assert.equal(validTheme("objection", null), false);
  assert.equal(validTheme("objection", 42), false);
});

test("themeLabel resolves labels; missing/other/unknown → Uncategorised", () => {
  assert.equal(themeLabel("objection", "money"), "Money & budget");
  assert.equal(themeLabel("objection", OTHER_KEY), "Uncategorised");
  assert.equal(themeLabel("objection", null), "Uncategorised");
  assert.equal(themeLabel("objection", "junk-slug"), "Uncategorised");
});

test("extraction prompt carries the theme contract and every theme key", () => {
  assert.ok(EXTRACTION_SYSTEM_PROMPT.includes('"theme"'), "output shape includes theme");
  for (const type of TYPES) {
    for (const t of THEMES[type]) {
      assert.ok(EXTRACTION_SYSTEM_PROMPT.includes(`"${t.key}"`), `prompt lists ${type}:${t.key}`);
    }
  }
});

test("classify prompt renders coherently: every key listed, other-guidance, JSON example intact", () => {
  for (const type of TYPES) {
    assert.ok(CLASSIFY_SYSTEM_PROMPT.includes(`${type}:`), `prompt has ${type} section`);
    for (const t of THEMES[type]) {
      assert.ok(CLASSIFY_SYSTEM_PROMPT.includes(`- "${t.key}": `), `prompt lists ${type}:${t.key} with blurb`);
    }
  }
  // Template-literal integrity: the ${...} interpolations must not have
  // swallowed the JSON example braces or leaked raw placeholders.
  assert.ok(CLASSIFY_SYSTEM_PROMPT.includes(`"${OTHER_KEY}"`), "other-key guidance rendered");
  assert.ok(!CLASSIFY_SYSTEM_PROMPT.includes("${"), "no unrendered template placeholders");
  assert.ok(CLASSIFY_SYSTEM_PROMPT.includes('{ "<id>": "<theme key>", ... }'), "JSON example shape intact");
});

// ─── Classifier output contract ──────────────────────────────────────

const batch = (n, type = "objection") =>
  Array.from({ length: n }, (_, i) => ({ id: `ci-${i}`, type, title: `t${i}` }));

test("clean response: every id assigned its theme, zero counters", () => {
  const items = batch(5);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  const r = validateClassifierOutput(items, parsed);
  assert.equal(Object.keys(r.assignments).length, 5);
  assert.equal(r.assignments["ci-0"], "money");
  assert.deepEqual(
    [r.otherCount, r.invalidCount, r.unknownCount],
    [0, 0, 0]
  );
});

test("off-list and cross-type values fall back to other and are counted", () => {
  const items = batch(10);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  parsed["ci-0"] = "lead-flow"; // painPoint theme on an objection — off-list for type
  parsed["ci-1"] = "totally-made-up";
  const r = validateClassifierOutput(items, parsed);
  assert.equal(r.assignments["ci-0"], OTHER_KEY);
  assert.equal(r.assignments["ci-1"], OTHER_KEY);
  assert.equal(r.invalidCount, 2);
  assert.equal(r.otherCount, 2);
});

test("a legitimate 'other' counts toward otherCount but not invalidCount", () => {
  const items = batch(10);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  parsed["ci-0"] = OTHER_KEY;
  const r = validateClassifierOutput(items, parsed);
  assert.equal(r.assignments["ci-0"], OTHER_KEY);
  assert.equal(r.invalidCount, 0);
  assert.equal(r.otherCount, 1);
});

test("hallucinated ids are dropped and counted, never written", () => {
  const items = batch(10);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  parsed["ci-999"] = "money"; // not in batch
  const r = validateClassifierOutput(items, parsed);
  assert.equal(r.unknownCount, 1);
  assert.equal("ci-999" in r.assignments, false);
});

test("quality gate: >20% junk throws (writes nothing)", () => {
  const items = batch(10);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  parsed["ci-0"] = "junk-1";
  parsed["ci-1"] = "junk-2";
  parsed["ci-2"] = "junk-3"; // 3/10 = 30% > 20%
  assert.throws(() => validateClassifierOutput(items, parsed), /quality gate/);
});

test("quality gate: exactly 20% junk passes", () => {
  const items = batch(10);
  const parsed = Object.fromEntries(items.map((i) => [i.id, "money"]));
  parsed["ci-0"] = "junk-1";
  parsed["ci-1"] = "junk-2"; // 2/10 = 20%, gate is strict >
  const r = validateClassifierOutput(items, parsed);
  assert.equal(r.invalidCount, 2);
});

test("non-object responses throw: array, null, string", () => {
  const items = batch(3);
  assert.throws(() => validateClassifierOutput(items, ["money"]));
  assert.throws(() => validateClassifierOutput(items, null));
  assert.throws(() => validateClassifierOutput(items, "money"));
});
