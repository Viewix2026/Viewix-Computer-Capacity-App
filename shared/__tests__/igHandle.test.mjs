import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIgHandle,
  igHandleProblemText,
  splitCompetitorsByValidity,
  describeBadHandles,
} from "../igHandle.js";

// ─── Plain handles ──────────────────────────────────────────────────

test("bare username", () => {
  assert.deepEqual(parseIgHandle("career_xl"), { handle: "@career_xl" });
});

test("@username", () => {
  assert.deepEqual(parseIgHandle("@career_xl"), { handle: "@career_xl" });
});

test("multiple leading @s and whitespace", () => {
  assert.deepEqual(parseIgHandle("  @@rivkin.wealth  "), { handle: "@rivkin.wealth" });
});

test("uppercase is lowercased (IG usernames are case-insensitive)", () => {
  assert.deepEqual(parseIgHandle("SaxoBank"), { handle: "@saxobank" });
});

test("trailing slash copied with the name", () => {
  assert.deepEqual(parseIgHandle("commsec/"), { handle: "@commsec" });
});

test("empty / blank input", () => {
  assert.equal(parseIgHandle("").reason, "empty");
  assert.equal(parseIgHandle("   ").reason, "empty");
  assert.equal(parseIgHandle(null).reason, "empty");
  assert.equal(parseIgHandle("@").reason, "empty");
});

test("free text with spaces is rejected", () => {
  assert.equal(parseIgHandle("element wealth advisors").reason, "invalid_username");
});

test("over-long username is rejected", () => {
  assert.equal(parseIgHandle("a".repeat(31)).reason, "invalid_username");
});

// ─── Profile URLs (salvageable) ─────────────────────────────────────

test("full profile URL", () => {
  assert.deepEqual(parseIgHandle("https://www.instagram.com/career_xl/"), { handle: "@career_xl" });
});

test("profile URL without scheme", () => {
  assert.deepEqual(parseIgHandle("instagram.com/elementwealthadvisors/"), { handle: "@elementwealthadvisors" });
});

test("profile URL with www but no scheme", () => {
  assert.deepEqual(parseIgHandle("www.instagram.com/cmcmarketsuk"), { handle: "@cmcmarketsuk" });
});

test("profile URL with query string / tracking params", () => {
  assert.deepEqual(parseIgHandle("https://www.instagram.com/saxobank/?igsh=abc123"), { handle: "@saxobank" });
});

test("the exact bug shape — @ prepended onto a pasted profile URL", () => {
  assert.deepEqual(parseIgHandle("@https://www.instagram.com/career_xl/"), { handle: "@career_xl" });
});

test("URL with @username in the path", () => {
  assert.deepEqual(parseIgHandle("https://www.instagram.com/@selfwealthaus/"), { handle: "@selfwealthaus" });
});

test("profile URL with deeper path (reels tab) still resolves the username", () => {
  assert.deepEqual(parseIgHandle("https://www.instagram.com/career_xl/reels/"), { handle: "@career_xl" });
});

// ─── Post / reel permalinks (unsalvageable — no username present) ───

test("reels permalink is rejected as post_link", () => {
  assert.equal(parseIgHandle("https://www.instagram.com/reels/DYAhcBAzckk/").reason, "post_link");
});

test("reel permalink (singular) is rejected as post_link", () => {
  assert.equal(parseIgHandle("https://www.instagram.com/reel/DWjtmVwkUJo/").reason, "post_link");
});

test("post permalink is rejected as post_link", () => {
  assert.equal(parseIgHandle("https://www.instagram.com/p/DXzHYKDxSto/").reason, "post_link");
});

test("@ prepended onto a reels permalink is still post_link", () => {
  assert.equal(parseIgHandle("@https://www.instagram.com/reels/DZFeCyilLsW/").reason, "post_link");
});

// ─── Wrong platform / wrong site ────────────────────────────────────

test("tiktok video link is rejected as tiktok", () => {
  const r = parseIgHandle("https://www.tiktok.com/@realdealproperty.com.au/video/7644122940342013202?_r=1&_t=ZS-973LTvmzNnZ");
  assert.equal(r.reason, "tiktok");
});

test("non-instagram URL is rejected as not_instagram", () => {
  assert.equal(parseIgHandle("https://www.youtube.com/@somebrand").reason, "not_instagram");
});

test("instagram.com root with no path is rejected", () => {
  assert.equal(parseIgHandle("https://www.instagram.com/").reason, "invalid_username");
});

// ─── Helpers ────────────────────────────────────────────────────────

test("igHandleProblemText covers every reason", () => {
  for (const reason of ["tiktok", "post_link", "not_instagram", "empty", "invalid_username"]) {
    assert.ok(igHandleProblemText(reason).length > 10, reason);
  }
});

test("splitCompetitorsByValidity salvages URLs, rejects links, dedupes, keeps fields", () => {
  const { cleaned, bad } = splitCompetitorsByValidity([
    { handle: "@https://www.instagram.com/career_xl/", tag: "direct", source: "manual" },
    { handle: "@career_xl", tag: "direct", source: "manual" },          // dupe after normalisation
    { handle: "@https://www.instagram.com/reels/DYAhcBAzckk/", tag: "inspiration" },
    { handle: "https://www.tiktok.com/@x/video/1", tag: "inspiration" },
    { handle: "@saxobank", tag: "direct", verified: true },
    { handle: null },                                                    // ignored, not "bad"
  ]);
  assert.deepEqual(cleaned.map(c => c.handle), ["@career_xl", "@saxobank"]);
  assert.equal(cleaned[0].tag, "direct");
  assert.equal(cleaned[1].verified, true);
  assert.deepEqual(bad.map(b => b.reason), ["post_link", "tiktok"]);
});

test("describeBadHandles truncates long URLs and names the problem", () => {
  const msg = describeBadHandles([
    { handle: "@https://www.tiktok.com/@realdealproperty.com.au/video/7644122940342013202", reason: "tiktok" },
    { handle: "@notaprofile link", reason: "invalid_username" },
  ]);
  assert.ok(msg.includes("…"), "long handle should be truncated");
  assert.ok(msg.includes("TikTok links aren't supported"));
  assert.ok(msg.includes(" · "));
});
