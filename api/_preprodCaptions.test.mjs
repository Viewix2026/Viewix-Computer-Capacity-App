// Dependency-free test for the pre-prod caption resolver.
// Run: node api/_preprodCaptions.test.mjs
//
// The invariant that MATTERS (Codex pass 4 P1): a row's spoken
// script (scriptNotes / script) must NEVER be returned as a caption.
// Captions only come from explicit caption fields. If none is
// authored, the resolver returns "" and the producer fills it in on
// the delivery side before scheduling.

import assert from "node:assert/strict";
import {
  extractCaptionsByVideoId,
  extractCaptionsByOrdinal,
  captionForVideoId,
} from "./_preprodCaptions.js";

// 1. socialCaption is the canonical source.
const docWithCaptions = {
  preproductionDoc: {
    scriptTable: [
      { videoNumber: 1, formatName: "Talking head", scriptNotes: "SPOKEN SCRIPT — do not leak", socialCaption: "Real caption one ✨" },
      { videoNumber: 2, formatName: "B-roll", scriptNotes: "More spoken script", socialCaption: "Real caption two 🎬" },
    ],
  },
};
const byIdx = extractCaptionsByOrdinal(docWithCaptions);
assert.equal(byIdx[0], "Real caption one ✨");
assert.equal(byIdx[1], "Real caption two 🎬");

// 2. CRITICAL: a row with scriptNotes but NO socialCaption must
//    resolve to empty — never the spoken script.
const docNoCaption = {
  preproductionDoc: {
    scriptTable: [
      { videoNumber: 1, formatName: "Talking head", scriptNotes: "Hi, in this video I'll show you three ways to...", hook: "spoken hook" },
    ],
  },
};
const noCapByIdx = extractCaptionsByOrdinal(docNoCaption);
assert.equal(noCapByIdx[0], undefined, "row with no socialCaption must NOT produce a caption from scriptNotes");
assert.equal(captionForVideoId(docNoCaption, null, 0), "", "captionForVideoId must return '' when only scriptNotes exists");
// Belt-and-braces: confirm the spoken script text never appears anywhere.
assert.ok(!JSON.stringify(noCapByIdx).includes("three ways"), "spoken script leaked into caption output");

// 3. videoId path wins when a row carries one.
const docWithVideoId = {
  preproductionDoc: {
    scriptTable: [
      { videoId: "vid-abc", socialCaption: "Caption keyed by id" },
    ],
  },
};
assert.equal(extractCaptionsByVideoId(docWithVideoId)["vid-abc"], "Caption keyed by id");
assert.equal(captionForVideoId(docWithVideoId, "vid-abc", 0), "Caption keyed by id");

// 4. ordinal fallback when no videoId match.
assert.equal(captionForVideoId(docWithCaptions, "no-such-id", 1), "Real caption two 🎬");

// 5. videoNumber takes precedence over array index for ordinal.
const docReordered = {
  preproductionDoc: {
    scriptTable: [
      { videoNumber: 3, socialCaption: "Third slot" },  // array index 0 but videoNumber 3
    ],
  },
};
const reordered = extractCaptionsByOrdinal(docReordered);
assert.equal(reordered[2], "Third slot");
assert.equal(reordered[0], undefined);

// 6. malformed / empty docs don't throw.
assert.deepEqual(extractCaptionsByOrdinal(null), []);
assert.deepEqual(extractCaptionsByVideoId(undefined), {});
assert.equal(captionForVideoId({}, "x", 0), "");

console.log("OK — _preprodCaptions: 6 groups passed (script never leaks as caption)");
