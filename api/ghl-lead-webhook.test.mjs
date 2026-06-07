// Regression tests for api/ghl-lead-webhook.js
// Covers the pre-Attio gates (auth, body-shape, preflight) and the
// unique-conflict detector — all reachable without network/Firebase, because
// the handler returns before any Attio/Firebase call on these paths.
//
// Run: node --test api/ghl-lead-webhook.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// Env must be set BEFORE importing the handler (module reads process.env at load).
process.env.GHL_WEBHOOK_SECRET = "test-secret";
process.env.ATTIO_API_KEY = "test-attio-key";

const mod = await import("./ghl-lead-webhook.js");
const handler = mod.default;
const { isUniqueConflict } = mod;

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}
const run = async (req) => { const res = mockRes(); await handler(req, res); return res; };

test("non-POST is rejected with 405", async () => {
  const res = await run({ method: "GET", headers: {}, body: {} });
  assert.equal(res.statusCode, 405);
});

test("OPTIONS preflight returns 200", async () => {
  const res = await run({ method: "OPTIONS", headers: {}, body: {} });
  assert.equal(res.statusCode, 200);
});

test("missing/wrong secret returns 401", async () => {
  const res = await run({ method: "POST", headers: {}, body: { secret: "nope" } });
  assert.equal(res.statusCode, 401);
});

test("FINDING 3: non-object body (raw string) with valid header secret returns 400, not a confusing 422", async () => {
  const res = await run({
    method: "POST",
    headers: { "x-ghl-secret": "test-secret" },
    body: "opportunityId=abc&email=x@y.com", // wrong Content-Type → Vercel leaves it a string
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /JSON object/);
});

test("FINDING 3: array body with valid secret returns 400", async () => {
  const res = await run({
    method: "POST",
    headers: { "x-ghl-secret": "test-secret" },
    body: [{ opportunityId: "abc" }],
  });
  assert.equal(res.statusCode, 400);
});

test("valid secret but blank required fields → 422 preflight hard-stop", async () => {
  const res = await run({
    method: "POST",
    headers: {},
    body: { secret: "test-secret", opportunityId: "  ", businessName: "", email: "" },
  });
  assert.equal(res.statusCode, 422);
  assert.ok(Array.isArray(res.body.missing));
  assert.deepEqual(res.body.missing.sort(), ["businessName", "email", "opportunityId"]);
});

test("isUniqueConflict: 409 status is a conflict", () => {
  assert.equal(isUniqueConflict({ statusCode: 409 }), true);
});

test("isUniqueConflict: Attio uniqueness messages are conflicts", () => {
  assert.equal(isUniqueConflict({ message: "value_already_exists for email_addresses" }), true);
  assert.equal(isUniqueConflict({ message: "Uniqueness constraint violated" }), true);
  assert.equal(isUniqueConflict({ message: "Email already exists" }), true);
});

test("isUniqueConflict: unrelated errors are NOT misclassified as conflicts", () => {
  assert.equal(isUniqueConflict({ statusCode: 400, message: "validation_type: bad payload" }), false);
  assert.equal(isUniqueConflict({ statusCode: 500, message: "internal error" }), false);
  assert.equal(isUniqueConflict({}), false);
  assert.equal(isUniqueConflict(null), false);
});
