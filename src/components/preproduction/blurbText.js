// Pure, framework-free helpers for turning a format's stored text into a
// single tidy client-facing sentence for the pre-production review page.
// Kept apart from ClientReview.jsx (which pulls in React + Firebase) so it
// can be unit-tested under plain node — see __tests__/blurbText.test.mjs.

// Minimum letters a candidate "sentence" must carry before we accept it.
// Set low — list markers ("1.", "2)") are stripped separately, so this
// only needs to fold tiny letter-fragments like "e.g."/"i.e." (and bare
// numbers like "2024.", which have zero letters) into the sentence that
// follows, without swallowing a legitimately short one like "Line one.".
const MIN_SENTENCE_CHARS = 3;

// Hard ceiling so a terminator-less run-on can't render as a paragraph.
const MAX_BLURB_CHARS = 200;

// Count letters (Unicode-aware, any script) — the measure of real word
// content in a candidate sentence. Letters, not digits: this both keeps a
// non-English blurb (CJK, accents) from being dropped as "empty", and
// stops a bare numeric prefix like a year ("2024.") or "100." from being
// treated as a sentence on its own — those fold into the text that follows.
function letterCount(s) {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

// Reduce arbitrary text to one brief, client-facing sentence.
// - Collapses whitespace/newlines to a single line.
// - Strips a leading list marker / bullet ("1.", "2)", "•", "- ") so the
//   first sentence isn't just the marker. Two deliberate limits: the
//   marker number is 1–2 digits (so a leading year like "2024." is kept,
//   not mistaken for a list item), and trailing whitespace is required
//   (so a decimal/version like "1.5" is never split, at the cost of not
//   stripping a space-less "1.Foo" — acceptable, that input is malformed).
// - Returns text up to the first sentence terminator (. ! ?) that carries
//   real content; short fragments (abbreviations, "Hi.") fold into the
//   next sentence rather than standing alone.
// - With no content-bearing terminator, returns the whole collapsed
//   string, cut on a word boundary at the length cap (never mid-word).
// Only strings are treated as text — a number/boolean/object/null source
// yields "" (no coercion, so a stray non-text field can't leak "123" or
// "[object Object]" to the client). The caller decides the empty fallback.
export function firstSentence(value) {
  if (typeof value !== "string") return "";
  let flat = value.replace(/\s+/g, " ").trim();
  flat = flat.replace(/^(?:\d{1,2}[.)]|[•*–-])\s+/, "").trim();
  if (!flat) return "";

  let out = "";
  const re = /[.!?](?=\s|$)/g;
  let match;
  while ((match = re.exec(flat)) !== null) {
    const candidate = flat.slice(0, match.index + 1).trim();
    if (letterCount(candidate) >= MIN_SENTENCE_CHARS) { out = candidate; break; }
  }
  if (!out) out = flat; // no content-bearing terminator → whole string

  if (out.length > MAX_BLURB_CHARS) {
    const slice = out.slice(0, MAX_BLURB_CHARS - 1);
    const lastSpace = slice.lastIndexOf(" ");
    // Cut on the last word boundary when there is one; only a single
    // space-less mega-token (a long URL, pathological data) falls back to
    // a raw slice — unbreakable input, acceptable degradation.
    out = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
  }
  if (letterCount(out) === 0) return ""; // no words → garbage ("...", "2024.")
  return out;
}

// Pick the first usable source for a format's blurb and collapse it to one
// sentence. Order of preference: the producer's client-facing description,
// then the AI video analysis, then filming / structure notes as a last
// resort so a format carrying only production notes still shows something
// (never "—" when any text exists). Each candidate is reduced
// independently; the first that yields a non-empty sentence wins.
export function formatBlurb(f) {
  if (!f || typeof f !== "object") return "—";
  const sources = [
    f.clientDescription,
    f.videoAnalysis,
    f.filmingInstructions,
    f.structureInstructions,
  ];
  for (const src of sources) {
    const s = firstSentence(src);
    if (s) return s;
  }
  return "—";
}
