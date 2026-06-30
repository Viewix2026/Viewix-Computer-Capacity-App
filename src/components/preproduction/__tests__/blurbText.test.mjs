// Pure unit tests for blurbText.js (format blurb → one client sentence).
// Run via:  node src/components/preproduction/__tests__/blurbText.test.mjs
// No test runner — assertions throw on failure, green summary on success.
// Cases trace directly to the Codex adversarial review of commit b1c9265.

import assert from "node:assert/strict";
import { firstSentence, formatBlurb } from "../blurbText.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };

// ── firstSentence: the happy path (the screenshot blurb) ────────────────
t("keeps just the first sentence of a paragraph", () => {
  const para =
    "The video opens with one of the employees introducing themselves and " +
    "what they do at the company. It uses emotional techie music. It also " +
    "opens on a montage of cool techie shots.";
  assert.equal(
    firstSentence(para),
    "The video opens with one of the employees introducing themselves and what they do at the company."
  );
});

t("collapses newlines/whitespace to a single line", () => {
  assert.equal(firstSentence("Line one.\nLine two."), "Line one.");
  assert.equal(firstSentence("Spaced   out    words here with no end"), "Spaced out words here with no end");
});

// ── Finding 3: leading list markers / abbreviations must not render alone ─
t("strips a leading numbered-list marker (was rendering '1.')", () => {
  assert.equal(firstSentence("1. Founder-led explainer of the product. Then a montage."),
    "Founder-led explainer of the product.");
});

t("strips a leading 'n)' list marker", () => {
  assert.equal(firstSentence("2) Day in the life of the team. More detail."),
    "Day in the life of the team.");
});

t("strips a leading bullet glyph", () => {
  assert.equal(firstSentence("• Customer testimonial montage here. Extra."),
    "Customer testimonial montage here.");
});

t("does NOT split a decimal/version like 1.5", () => {
  assert.equal(firstSentence("1.5 minute walkthrough of the product."),
    "1.5 minute walkthrough of the product.");
});

t("folds a leading abbreviation into the real sentence ('e.g.')", () => {
  assert.equal(firstSentence("e.g. founder walkthrough with a product demo. Next."),
    "e.g. founder walkthrough with a product demo.");
});

t("folds a tiny leading fragment ('Hi.') into the next sentence", () => {
  assert.equal(firstSentence("Hi. Welcome to our explainer format video."),
    "Hi. Welcome to our explainer format video.");
});

t("pure-punctuation garbage yields empty string", () => {
  assert.equal(firstSentence("..."), "");
  assert.equal(firstSentence("?!"), "");
});

// ── Round 2: leading marker strip is bounded to 1-2 digit list items ─────
t("does NOT strip a leading 4-digit year as a list marker", () => {
  assert.equal(firstSentence("2024. Results from the launch campaign. More."),
    "2024. Results from the launch campaign.");
});

t("still strips a 2-digit list marker", () => {
  assert.equal(firstSentence("10. Behind the scenes of the shoot. Extra."),
    "Behind the scenes of the shoot.");
});

t("documented limit: a space-less marker '1.Foo' is left intact", () => {
  // The trailing-whitespace requirement protects decimals like 1.5, at the
  // cost of not stripping malformed "1.Foo" — intentional, locked here.
  assert.equal(firstSentence("1.Founder-led explainer of the product."),
    "1.Founder-led explainer of the product.");
});

// ── Round 2: Unicode-aware content check ────────────────────────────────
t("keeps a non-ASCII-only sentence instead of dropping it", () => {
  assert.equal(firstSentence("你好世界."), "你好世界.");
  assert.equal(firstSentence("Café launch."), "Café launch.");
});

// ── Finding 2: non-string input must not throw ──────────────────────────
t("non-string input yields '' (never throws, never leaks a coerced value)", () => {
  assert.equal(firstSentence(null), "");
  assert.equal(firstSentence(undefined), "");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence({}), "");          // not "[object Object]"
  assert.equal(firstSentence(123), "");         // not "123"
  assert.equal(firstSentence(true), "");
});

// ── Finding 4: length cap cuts on a word boundary, never mid-word ────────
t("over-long terminator-less text is cut on a word boundary with ellipsis", () => {
  const longRunOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const out = firstSentence(longRunOn);
  assert.ok(out.endsWith("…"), "should end with ellipsis");
  assert.ok(out.length <= 200, "should respect the cap");
  // The char before the ellipsis must be a full word, not a sliced fragment.
  const body = out.slice(0, -1);
  assert.ok(/word\d+$/.test(body), `expected a whole word at the cut, got: ${body}`);
});

t("cuts at an early word boundary rather than mid-word (lastSpace <= 40)", () => {
  // One short leading word, then a long unbroken-ish tail with spaces.
  const text = "Intro " + Array.from({ length: 40 }, (_, i) => `tok${i}`).join(" ");
  const out = firstSentence(text);
  assert.ok(out.endsWith("…"));
  assert.ok(/tok\d+$/.test(out.slice(0, -1)) || out === "Intro…",
    `expected a whole-word cut, got: ${out}`);
});

// ── formatBlurb: source preference + Finding 1 (no false "—") ───────────
t("shows the client-facing description IN FULL (not just the first sentence)", () => {
  const f = {
    clientDescription:
      "A cinematic spotlight on one team member, introducing who they are and how they help. " +
      "Personal, polished, and perfect for putting a specific doctor or nurse in the spotlight.",
    videoAnalysis: "Long AI text. More.",
  };
  assert.equal(formatBlurb(f),
    "A cinematic spotlight on one team member, introducing who they are and how they help. " +
    "Personal, polished, and perfect for putting a specific doctor or nurse in the spotlight.");
});

t("tidies whitespace/newlines in the client description but keeps all content", () => {
  const f = { clientDescription: "  Line one of the blurb.\n\nLine two of the blurb.  " };
  assert.equal(formatBlurb(f), "Line one of the blurb. Line two of the blurb.");
});

t("falls back to the FIRST SENTENCE of videoAnalysis when no clientDescription", () => {
  const f = { videoAnalysis: "AI describes the format clearly. Extra detail we drop." };
  assert.equal(formatBlurb(f), "AI describes the format clearly.");
});

t("Finding 1: falls back to filming/structure notes instead of '—'", () => {
  const f = { filmingInstructions: "Handheld, golden hour, vertical framing throughout." };
  assert.equal(formatBlurb(f), "Handheld, golden hour, vertical framing throughout.");
  const f2 = { structureInstructions: "Hook then problem then solution then CTA." };
  assert.equal(formatBlurb(f2), "Hook then problem then solution then CTA.");
});

t("skips an empty earlier source and uses the next non-empty one", () => {
  const f = { clientDescription: "   ", videoAnalysis: "", filmingInstructions: "Locked-off interview setup with two cameras." };
  assert.equal(formatBlurb(f), "Locked-off interview setup with two cameras.");
});

t("returns '—' only when every source is empty/missing", () => {
  assert.equal(formatBlurb({}), "—");
  assert.equal(formatBlurb(null), "—");
  assert.equal(formatBlurb({ clientDescription: "", videoAnalysis: null }), "—");
});

t("skips a non-string source (e.g. clientDescription set to 0) and falls through", () => {
  assert.equal(formatBlurb({ clientDescription: 0, videoAnalysis: "Real format description here." }),
    "Real format description here.");
  assert.equal(formatBlurb({ clientDescription: 0 }), "—");
});

console.log(`\n✅ blurbText: ${n} tests passed\n`);
