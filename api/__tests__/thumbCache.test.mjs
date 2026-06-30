// Unit tests for api/_thumbCache.js — pure helpers (no network, no RTDB).
// Run via:  node --test api/__tests__/thumbCache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  thumbKeyFromUrl,
  youTubeIdFromUrl,
  sniffImageType,
  toDataUri,
  isAllowedImageHost,
  MAX_THUMB_BYTES,
} from "../_thumbCache.js";

test("thumbKeyFromUrl — Instagram shapes", () => {
  assert.deepEqual(thumbKeyFromUrl("https://www.instagram.com/reel/Cabc-123_x/"), { platform: "ig", videoId: "Cabc-123_x" });
  assert.deepEqual(thumbKeyFromUrl("https://instagram.com/p/XYZ789/?igshid=foo"), { platform: "ig", videoId: "XYZ789" });
  assert.deepEqual(thumbKeyFromUrl("https://www.instagram.com/reels/AbC/"), { platform: "ig", videoId: "AbC" });
});

test("thumbKeyFromUrl — TikTok", () => {
  assert.deepEqual(thumbKeyFromUrl("https://www.tiktok.com/@someone/video/7300000000000000000"), { platform: "tiktok", videoId: "7300000000000000000" });
  assert.deepEqual(thumbKeyFromUrl("https://www.tiktok.com/video/7311111111111111111"), { platform: "tiktok", videoId: "7311111111111111111" });
});

test("thumbKeyFromUrl — YouTube and junk are not cacheable (null)", () => {
  assert.equal(thumbKeyFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(thumbKeyFromUrl("https://youtu.be/dQw4w9WgXcQ"), null);
  assert.equal(thumbKeyFromUrl("https://example.com/foo"), null);
  assert.equal(thumbKeyFromUrl(""), null);
  assert.equal(thumbKeyFromUrl(null), null);
});

test("thumbKeyFromUrl — videoIds contain no RTDB-forbidden chars", () => {
  for (const u of [
    "https://www.instagram.com/reel/Cabc-123_x/",
    "https://www.tiktok.com/@x/video/7300000000000000000",
  ]) {
    const k = thumbKeyFromUrl(u);
    assert.ok(k);
    assert.doesNotMatch(k.videoId, /[.$#[\]/]/, `key ${k.videoId} has a forbidden char`);
  }
});

test("youTubeIdFromUrl — matches ReelPreview semantics", () => {
  assert.equal(youTubeIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youTubeIdFromUrl("https://youtu.be/dQw4w9WgXcQ?si=abc"), "dQw4w9WgXcQ");
  assert.equal(youTubeIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  // a longer slug must fail rather than truncate to a wrong 11-char id
  assert.equal(youTubeIdFromUrl("https://youtu.be/ABCDEFGHIJKLMNOP"), null);
});

test("sniffImageType — recognises real formats, rejects HTML", () => {
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), "image/png");
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 1, 1, 1, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageType(webp), "image/webp");
  // "<!DOCTYPE ht" — an error page must not sniff as an image
  assert.equal(sniffImageType(Buffer.from("<!DOCTYPE ht")), null);
  assert.equal(sniffImageType(Buffer.from([1, 2])), null);
});

test("isAllowedImageHost — only https provider CDNs; blocks SSRF targets", () => {
  // allowed provider CDNs
  assert.equal(isAllowedImageHost("https://scontent-syd2-1.cdninstagram.com/v/t51/abc.jpg"), true);
  assert.equal(isAllowedImageHost("https://instagram.fmel1-1.fna.fbcdn.net/v/abc.jpg"), true);
  assert.equal(isAllowedImageHost("https://p16-sign-sg.tiktokcdn.com/obj/abc"), true);
  assert.equal(isAllowedImageHost("https://x.tiktokcdn-us.com/obj/abc"), true);
  // SSRF / non-provider / non-https targets
  assert.equal(isAllowedImageHost("http://169.254.169.254/latest/meta-data/"), false); // link-local + http
  assert.equal(isAllowedImageHost("https://169.254.169.254/"), false);                 // IP literal
  assert.equal(isAllowedImageHost("http://127.0.0.1/"), false);
  assert.equal(isAllowedImageHost("https://localhost/"), false);
  assert.equal(isAllowedImageHost("https://evil.com/cdninstagram.com/x.jpg"), false);   // path tricks
  assert.equal(isAllowedImageHost("https://cdninstagram.com.evil.com/x.jpg"), false);   // suffix spoofing
  assert.equal(isAllowedImageHost("https://i.ytimg.com/vi/x/hqdefault.jpg"), false);     // YouTube never downloaded
  assert.equal(isAllowedImageHost("not a url"), false);
  assert.equal(isAllowedImageHost(null), false);
});

test("toDataUri — builds a data URI and enforces the byte cap", () => {
  const small = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const uri = toDataUri(small, "image/jpeg");
  assert.match(uri, /^data:image\/jpeg;base64,/);
  assert.equal(uri, `data:image/jpeg;base64,${small.toString("base64")}`);

  // over cap -> null
  const big = Buffer.alloc(MAX_THUMB_BYTES + 1, 0x41);
  assert.equal(toDataUri(big, "image/jpeg"), null);

  // non-image content type falls back to image/jpeg label, still encodes
  assert.match(toDataUri(small, "text/html"), /^data:image\/jpeg;base64,/);
  assert.equal(toDataUri(Buffer.alloc(0), "image/jpeg"), null);
});
