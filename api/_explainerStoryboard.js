// api/_explainerStoryboard.js
// Pure logic for the Explainer Storyboard Generator (Stage 1 of the Vox-style
// explainer pipeline — docs/plans/vox-explainer-remotion-scope-packet.md).
// Underscore-prefixed so Vercel doesn't deploy it as an endpoint; imported by
// api/explainer-storyboard.js and unit-tested in isolation (no firebase-admin).
//
// `normalizeStoryboard` is the trust boundary: it coerces Claude's JSON into a
// bounded, well-typed storyboard and drops anything unexpected.

// Sonnet 4.6 — a storyboard is structured creative text, not the heavy visual
// generation motion-graphics needs Opus for. Already the repo's validated model
// for text work (the motion-graphics "enhance" call), and its rates are known,
// so the cost ledger stays honest without a guessed price.
export const MODEL = "claude-sonnet-4-6";
export const PRICE = {
  inPerMTok: 3.0,
  outPerMTok: 15.0,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  pricedAt: "2026-06-24",
  model: MODEL,
};

export const LIMITS = {
  topic: 2000,
  script: 12000,      // a pasted rough script/notes block
  refineInstruction: 1000,
  minScenes: 3,
  maxScenes: 24,      // hard ceiling on scenes we keep from the model
  fieldChars: 1200,   // per storyboard text field (voiceover, prompts, …)
  dailyPerUser: 100,  // runaway-loop circuit breaker, not a budget
  savedName: 120,
  savedBlob: 200 * 1024, // 200KB serialized storyboard ceiling
};

export const TONES = new Set(["vox", "documentary", "punchy", "corporate", "educational"]);

export function clampStr(v, max = LIMITS.fieldChars) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ─── normalizeStoryboard — THE trust boundary ─────────────────────────────────
// Coerce Claude's JSON into a bounded, well-typed storyboard. NEVER trusts field
// types, counts, or lengths from the model.
export function normalizeStoryboard(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    let s = raw.trim();
    // Strip a single ``` / ```json fence if the model wrapped its JSON.
    if (s.startsWith("```")) s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    // Fall back to the first {...} block if there's prose around the JSON.
    if (!s.startsWith("{")) {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) s = m[0];
    }
    try { obj = JSON.parse(s); }
    catch { throw new Error("The model didn't return a usable storyboard — try again."); }
  }
  if (!obj || typeof obj !== "object") throw new Error("The model didn't return a usable storyboard — try again.");

  const vsIn = obj.visualSystem && typeof obj.visualSystem === "object" ? obj.visualSystem : {};
  const visualSystem = {
    // The one locked background shared across every scene — the crux of the Vox
    // "one continuous shot" look the video describes.
    background: clampStr(vsIn.background),
    palette: clampStr(vsIn.palette, 300),
    fonts: clampStr(vsIn.fonts, 300),
    treatment: clampStr(vsIn.treatment, 600), // e.g. "black & white halftone cutouts, offset red marker stroke"
  };

  const scenesIn = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes = scenesIn.slice(0, LIMITS.maxScenes).map((sc, i) => {
    const s = sc && typeof sc === "object" ? sc : {};
    let dur = Number(s.durationSec);
    if (!Number.isFinite(dur) || dur <= 0) dur = 4;
    dur = Math.max(1, Math.min(20, Math.round(dur * 10) / 10));
    return {
      n: i + 1,
      beat: clampStr(s.beat || s.title, 200),
      voiceover: clampStr(s.voiceover || s.narration),
      foreground: clampStr(s.foreground),
      midground: clampStr(s.midground),
      foregroundPrompt: clampStr(s.foregroundPrompt),
      midgroundPrompt: clampStr(s.midgroundPrompt),
      durationSec: dur,
    };
  }).filter(sc => sc.voiceover || sc.beat); // drop empty rows

  if (scenes.length < 1) throw new Error("The storyboard came back empty — try a clearer topic.");

  const title = clampStr(obj.title, 200);
  const totalSec = Number(scenes.reduce((a, sc) => a + sc.durationSec, 0).toFixed(1));

  return { title, visualSystem, scenes, sceneCount: scenes.length, totalSec };
}

// ─── System prompt ────────────────────────────────────────────────────────────
export function buildSystemPrompt(tone, targetSec) {
  const toneLine = {
    vox: "Vox-style explainer: crisp, punchy, one idea per beat, builds an argument to a payoff.",
    documentary: "Measured documentary voice: grounded, factual, lets tension build slowly.",
    punchy: "Fast social-first: very short beats, hooks early, high energy.",
    corporate: "Clean corporate explainer: clear, credible, benefit-led.",
    educational: "Teacherly explainer: define, illustrate, reinforce.",
  }[tone] || "Vox-style explainer: crisp, punchy, one idea per beat.";

  return [
    "You are a motion-graphics storyboard writer for Viewix, a video production studio.",
    "You turn a topic (and any rough script the user pastes) into a STORYBOARD for a short animated explainer built in Remotion, in the style of Vox explainer videos.",
    "",
    "The storyboard IS the timeline: each scene maps one voiceover beat to a visual. The film uses ONE locked background shared across every scene (this is what gives the 'one continuous shot' feel) — only the midground and foreground change per scene.",
    "Layer model per scene:",
    "  • background — the single shared/locked backdrop (same every scene; describe it ONCE in visualSystem.background and don't restate it per scene).",
    "  • midground — the subject cutouts that pop in (people/characters), rendered as black-and-white halftone cutouts with an offset red marker stroke behind them.",
    "  • foreground — structures / scenery / charts / shapes that frame the subject.",
    "",
    `Tone: ${toneLine}`,
    `Target total duration: about ${targetSec} seconds. Size the number of scenes and each scene's durationSec to fit — a beat is usually 2–6 seconds. Durations across all scenes should roughly sum to the target.`,
    "For each scene write an image-generation PROMPT for the midground and (if used) the foreground — concrete, art-directed prompts an image generator can run (subject, framing, the black-and-white halftone + red-stroke treatment, transparent background for cutouts).",
    "",
    "Return ONLY valid JSON (no prose, no markdown, no code fences) with EXACTLY this shape:",
    "{",
    '  "title": string,',
    '  "visualSystem": { "background": string, "palette": string, "fonts": string, "treatment": string },',
    '  "scenes": [ { "beat": string, "voiceover": string, "midground": string, "foreground": string, "midgroundPrompt": string, "foregroundPrompt": string, "durationSec": number } ]',
    "}",
    "voiceover is the exact narration line for that beat. Keep every string tight. Do not include any field not listed above.",
  ].join("\n");
}

// ─── Cost ──────────────────────────────────────────────────────────────────────
export function computeCost(usage, price = PRICE) {
  const u = usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cost =
    (inTok * price.inPerMTok + outTok * price.outPerMTok +
      cacheWrite * price.cacheWritePerMTok + cacheRead * price.cacheReadPerMTok) / 1_000_000;
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    costUsd: Number(cost.toFixed(6)),
  };
}

// ─── Ids ────────────────────────────────────────────────────────────────────────
export function genId() {
  return `sb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export const ID_RE = /^sb_[a-z0-9_]+$/i;
export const validId = s => typeof s === "string" && s.length <= 64 && ID_RE.test(s);
