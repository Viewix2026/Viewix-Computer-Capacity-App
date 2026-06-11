// tests/training-visibility.test.js
// Per-role Training category visibility — deny by default.
// Run with `node --test tests/*.test.js`.
//
// Regression for the 2026-06-11 incident: the old ternary chain in
// Training.jsx defaulted unmatched roles to the FULL library (including
// Sales Training). The helper must fall through to the trial view instead.

import test from "node:test";
import assert from "node:assert/strict";
import { visibleTrainingCategories } from "../src/lib/trainingVisibility.js";

// Mirrors the live /training category names as of 2026-06-11.
const CATS = [
  { id: "c1", name: "Editor Onboarding" },
  { id: "c2", name: "Sales Training" },
  { id: "c3", name: "Producer Onboarding" },
  { id: "c4", name: "Trial Editor Onboarding" },
];

const names = (role) => visibleTrainingCategories(role, CATS).map((c) => c.name);

test("trial sees only Trial Editor Onboarding", () => {
  assert.deepEqual(names("trial"), ["Trial Editor Onboarding"]);
});

test("closer sees only sales-named categories", () => {
  assert.deepEqual(names("closer"), ["Sales Training"]);
});

test("editor sees everything except sales-named categories", () => {
  assert.deepEqual(names("editor"), [
    "Editor Onboarding",
    "Producer Onboarding",
    "Trial Editor Onboarding",
  ]);
});

test("founders, manager, and lead see everything", () => {
  for (const role of ["founders", "manager", "lead"]) {
    assert.deepEqual(names(role), CATS.map((c) => c.name), role);
  }
});

test("legacy founder alias normalises to manager and sees everything", () => {
  assert.deepEqual(names("founder"), CATS.map((c) => c.name));
});

test("unrecognised or missing roles fall through to the trial view, never the full library", () => {
  for (const role of ["intern", "Trial", "EDITOR", "", null, undefined]) {
    assert.deepEqual(names(role), ["Trial Editor Onboarding"], String(role));
  }
});

test("categories without a name are treated as restricted, not crashed on", () => {
  const ragged = [...CATS, { id: "c5" }, { id: "c6", name: null }];
  assert.deepEqual(
    visibleTrainingCategories("trial", ragged).map((c) => c.id),
    ["c4"]
  );
  // editors still see nameless categories (they only exclude sales-named ones)
  assert.deepEqual(
    visibleTrainingCategories("editor", ragged).map((c) => c.id),
    ["c1", "c3", "c4", "c5", "c6"]
  );
});
