// Dependency-free regression test for the Idea Selection → Scripting
// row-count guarantee.
// Run: node api/__tests__/social-organic-script-cap.test.mjs   (npm run test:script-cap)
//
// Bug (Luke, 2026-06): producer generates 10 ideas per format across 4
// formats (40 total), ticks ~13, but Scripting produced ~40 rows — the
// unticked ideas leaked back in. Selections ARE persisted and the server
// DOES filter to ticked ideas before prompting; the leak was that nothing
// hard-bound the row count to the ticked count, so the model padded the
// table back up to the round's numberOfVideos.
//
// Invariant under test: selecting N ideas yields EXACTLY N script rows,
// regardless of how many rows the model returns. Legacy projects (no
// ticked ideas) are untouched.

import assert from "node:assert/strict";
import {
  capScriptRowsToTickedCount,
  chunkSelectedFormatsForScripting,
} from "../social-organic.js";

const rows = (n) => Array.from({ length: n }, (_, i) => ({ videoNumber: i + 1 }));

// ── 1. The exact bug: 13 ticked, model returns 40. ──────────────────────
// Reproduce the real pipeline: 4 formats with ticked counts 4/3/3/3 = 13,
// chunked at the production BATCH_SIZE, then a runaway model returns far
// more rows than asked per batch. The cap must bring the total to 13.
const BATCH_SIZE = 4;
const formats = [
  { id: "f1", name: "A", _tickedIdeas: rows(4).map((_, i) => ({ title: `a${i}`, text: "" })) },
  { id: "f2", name: "B", _tickedIdeas: rows(3).map((_, i) => ({ title: `b${i}`, text: "" })) },
  { id: "f3", name: "C", _tickedIdeas: rows(3).map((_, i) => ({ title: `c${i}`, text: "" })) },
  { id: "f4", name: "D", _tickedIdeas: rows(3).map((_, i) => ({ title: `d${i}`, text: "" })) },
];
const totalTicked = 13;

const batches = chunkSelectedFormatsForScripting(formats, BATCH_SIZE);
// Sanity: chunker preserves the ticked total across batches.
const batchedTicked = batches.reduce(
  (s, b) => s + b.reduce((ss, f) => ss + (f._tickedIdeas?.length || 0), 0), 0);
assert.equal(batchedTicked, totalTicked, "chunker must preserve the ticked total");

// Each batch's model "returns" 10 rows per format in it (the runaway).
let totalRows = 0;
for (const batch of batches) {
  const runaway = rows(batch.length * 10); // way more than ticked
  const capped = capScriptRowsToTickedCount(runaway, batch, /* hasIdeas */ true);
  const expected = batch.reduce((s, f) => s + (f._tickedIdeas?.length || 0), 0);
  assert.equal(capped.length, expected, "each batch is capped to its ticked count");
  totalRows += capped.length;
}
assert.equal(totalRows, 13, "13 ideas selected must produce exactly 13 script rows, not 40");

// ── 2. Single batch, direct: 5 ticked, 12 returned → 5. ─────────────────
const batch = [
  { id: "x", _tickedIdeas: [{ title: "1" }, { title: "2" }, { title: "3" }] },
  { id: "y", _tickedIdeas: [{ title: "4" }, { title: "5" }] },
];
assert.equal(capScriptRowsToTickedCount(rows(12), batch, true).length, 5);

// ── 3. No over-production: 4 ticked, 4 returned → 4 (unchanged identity). ─
const four = rows(4);
const exact = capScriptRowsToTickedCount(four, [{ id: "z", _tickedIdeas: rows(4) }], true);
assert.equal(exact.length, 4);
assert.equal(exact[0].videoNumber, 1, "rows kept in order, first-ticked-first");

// ── 4. Under-production is NOT padded: 6 ticked, 4 returned → 4. ─────────
assert.equal(capScriptRowsToTickedCount(rows(4), [{ id: "u", _tickedIdeas: rows(6) }], true).length, 4);

// ── 5. Legacy path untouched: hasIdeas=false leaves rows alone. ─────────
const legacyBatch = [{ id: "L", _videoCount: 10, _tickedIdeas: null }];
assert.equal(capScriptRowsToTickedCount(rows(10), legacyBatch, false).length, 10,
  "legacy (videoCount-driven) projects must keep their row count");

// ── 6. Defensive: non-array input. ──────────────────────────────────────
assert.deepEqual(capScriptRowsToTickedCount(null, batch, true), []);

console.log("✓ social-organic script-cap regression: all assertions passed (13 selected → 13 scripts)");
