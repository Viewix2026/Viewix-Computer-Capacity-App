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
const { isUniqueConflict, validStage, isForwardStage, flattenGhlBody, splitName, buildDealInfo } = mod;

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

test("GHL nests secret under customData → auth still passes (reaches preflight, not 401)", async () => {
  // Real GHL shape: secret lives in customData, and the only required fields are
  // contact_id + email. Missing those → 422 (NOT 401), proving the customData
  // secret was accepted and company/business name is NOT required.
  const res = await run({
    method: "POST",
    headers: {},
    body: { customData: { secret: "test-secret" }, contact_id: "  ", email: "" },
  });
  assert.equal(res.statusCode, 422);
  assert.ok(Array.isArray(res.body.missing));
  assert.deepEqual(res.body.missing.sort(), ["contact_id", "email"]);
  assert.ok(!res.body.missing.includes("businessName")); // company is optional
  assert.ok(!res.body.missing.includes("company_name"));
});

test("wrong customData secret still 401s", async () => {
  const res = await run({
    method: "POST", headers: {},
    body: { customData: { secret: "nope" }, contact_id: "abc", email: "x@y.com" },
  });
  assert.equal(res.statusCode, 401);
});

test("flattenGhlBody: customData merges to top level", () => {
  const flat = flattenGhlBody({ contact_id: "c1", email: "a@b.com", customData: { secret: "s", stage: "Meeting Booked" } });
  assert.equal(flat.contact_id, "c1");
  assert.equal(flat.secret, "s");
  assert.equal(flat.stage, "Meeting Booked");
  // top-level wins over customData on collision
  assert.equal(flattenGhlBody({ stage: "Lead", customData: { stage: "Won" } }).stage, "Lead");
  // tolerates missing/none customData
  assert.equal(flattenGhlBody({ email: "a@b.com" }).email, "a@b.com");
});

test("buildDealInfo: captures top-level survey answers from a REAL GHL payload, excludes standard fields + nested objects", () => {
  // Shape mirrors a real Rhythm Republic survey lead.
  const body = {
    "Form Multichoice Question 1": "",
    "Survey Question 1 ": "I know I should do it, but I don't have time.",
    "Survey Question 2": "More inbound leads from Facebook and Instagram.",
    "Survey Question 3": "Pre Revenue",
    "What's currently your biggest goal or hurdle? ": "New business starting from scratch",
    company_name: "Rhythm Republic",
    contact_id: "abc", email: "ray@x.com", full_name: "Ray R", phone: "+61400000000",
    contact_source: "2-step funnel | meta ads", contact_type: "lead", country: "AU",
    tags: "", timezone: "Australia/Sydney", date_created: "2026-06-07T08:06:48.579Z",
    location: { name: "Viewix" }, workflow: { name: "ATTIO SYNC" },
    attributionSource: { fbc: "fb.2...", url: "https://..." }, customData: { secret: "s" },
  };
  const info = buildDealInfo(body);
  assert.equal(info,
    "Survey Question 1: I know I should do it, but I don't have time.\n" +
    "Survey Question 2: More inbound leads from Facebook and Instagram.\n" +
    "Survey Question 3: Pre Revenue\n" +
    "What's currently your biggest goal or hurdle?: New business starting from scratch");
  for (const bad of ["Rhythm Republic", "ray@x.com", "fb.2", "Viewix", "ATTIO SYNC", "meta ads", "Australia/Sydney"]) {
    assert.ok(!info.includes(bad), `leaked standard field: ${bad}`);
  }
  assert.ok(!info.includes("Form Multichoice")); // blank answer dropped
});

test("buildDealInfo: humanises technical keys; tolerates empty/null/array", () => {
  assert.equal(buildDealInfo({ businessGoals: "Leads", monthly_budget: "$5k" }), "Business Goals: Leads\nMonthly Budget: $5k");
  assert.equal(buildDealInfo({ secret: "s", customData: { secret: "s" } }), ""); // only plumbing → nothing
  assert.equal(buildDealInfo(null), "");
  assert.equal(buildDealInfo(undefined), "");
  assert.equal(buildDealInfo([{ goals: "x" }]), ""); // array → ignored
});

test("splitName: derives first/last from full_name when not provided", () => {
  assert.deepEqual(splitName("Con Koumoulas", "", ""), { first: "Con", last: "Koumoulas", full: "Con Koumoulas" });
  assert.deepEqual(splitName("Madonna", "", ""), { first: "Madonna", last: "", full: "Madonna" });
  assert.deepEqual(splitName("Mary Jane Watson", "", ""), { first: "Mary", last: "Jane Watson", full: "Mary Jane Watson" });
  // explicit first/last are respected (not overwritten)
  assert.deepEqual(splitName("ignored", "Jane", "Doe"), { first: "Jane", last: "Doe", full: "ignored" });
  // empty everything
  assert.deepEqual(splitName("", "", ""), { first: "", last: "", full: "" });
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

test("validStage: only known pipeline stages pass; anything else → null", () => {
  assert.equal(validStage("Lead"), "Lead");
  assert.equal(validStage("Meeting Booked"), "Meeting Booked");
  assert.equal(validStage(" Meeting Booked "), "Meeting Booked"); // trimmed
  assert.equal(validStage("Won"), "Won");
  assert.equal(validStage("Closed Won"), null); // not a real Attio stage
  assert.equal(validStage(""), null);
  assert.equal(validStage(undefined), null);
  assert.equal(validStage("constructor"), null); // no prototype-key leakage
});

test("isForwardStage: advances forward only, never regresses", () => {
  // STEP 2 lifts a Lead → Meeting Booked
  assert.equal(isForwardStage("Lead", "Meeting Booked"), true);
  // repeated STEP 2 reminder on an already-booked deal → no move
  assert.equal(isForwardStage("Meeting Booked", "Meeting Booked"), false);
  // deal the team advanced to Quoted/Won must NOT be pulled back to Meeting Booked
  assert.equal(isForwardStage("Quoted", "Meeting Booked"), false);
  assert.equal(isForwardStage("Won", "Meeting Booked"), false);
  assert.equal(isForwardStage("Lost", "Meeting Booked"), false);
  // a missing/unknown current stage is treated as rank 0 → any known stage advances
  assert.equal(isForwardStage(null, "Lead"), true);
  // unknown requested stage never advances
  assert.equal(isForwardStage("Lead", "Bogus"), false);
});

test("STEP 1 refire (no/Lead stage) never advances an existing deal", () => {
  // STEP 1 sends no stage → requestedStage resolves to null/Lead; an existing
  // Lead (or anything further) is never moved by a STEP 1 refire.
  assert.equal(isForwardStage("Lead", validStage(undefined)), false); // null requested
  assert.equal(isForwardStage("Lead", "Lead"), false);
  assert.equal(isForwardStage("Meeting Booked", "Lead"), false);
});
