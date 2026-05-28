// Contract pin for the PUBLIC delivery-AM endpoint.
// Run: npm run test:delivery-am   (node api/public/delivery-am.test.mjs)
// Needs deps installed — importing the handler pulls in firebase-admin
// transitively (via _fb-admin.js), even though every assertion below
// exercises only the DB-free pure helpers + pre-DB handler guards.
//
// This endpoint is the only NEW public exposure in the delivery-surface
// unification, so its contract is pinned hard: only the `accountManager`
// envelope with exactly five fields ever leaves the server; ambiguous
// ownership fails closed; the handler rejects non-GET and bad ids before
// it ever touches the database.

import assert from "node:assert/strict";
import handler, {
  DELIVERY_ID_RE, findOwningProject, buildAmEnvelope,
} from "./delivery-am.js";

// ── Fixtures ──
const account = {
  id: "acct-1", companyName: "Acme Co", accountManager: "Jordan Tan",
  accountManagerPhoto: "https://fallback/jordan.jpg",
  accountManagerEmail: "fallback@viewix.test",
  projectLead: "Internal Lead", attioId: "att-1", dealValue: 48000,
  BRAND_NEW_SECRET_FIELD: "nope",
};
const editors = {
  "ed-x": { id: "ed-x", name: "Someone Else", avatarUrl: "https://x/other.jpg", phone: "0411", email: "other@viewix.test", bookingUrl: "https://cal/other" },
  "ed-j": { id: "ed-j", name: "Jordan Tan", avatarUrl: "https://x/jordan.jpg", phone: "0422", email: "jordan@viewix.test", bookingUrl: "https://cal/jordan" },
};
const projects = {
  "proj-1": { id: "proj-1", links: { deliveryId: "del-111", accountId: "acct-1" } },
  "proj-2": { id: "proj-2", links: { deliveryId: "del-222", accountId: "acct-9" } },
};

// ── 1. deliveryId validation ──
assert.ok(DELIVERY_ID_RE.test("del-1700000000000"), "real del- id valid");
assert.ok(DELIVERY_ID_RE.test("del-abc123"), "base36 del- id valid");
assert.ok(!DELIVERY_ID_RE.test(""), "empty rejected");
assert.ok(!DELIVERY_ID_RE.test("1700000000000"), "missing del- prefix rejected");
assert.ok(!DELIVERY_ID_RE.test("del-../../etc"), "path traversal rejected");
assert.ok(!DELIVERY_ID_RE.test("del-" + "a".repeat(41)), "oversized rejected");

// ── 2. findOwningProject — fail closed on 0 / >1 ──
assert.equal(findOwningProject(projects, "del-111").project?.id, "proj-1", "single match resolves");
assert.equal(findOwningProject(projects, "del-111").ambiguous, false);
assert.equal(findOwningProject(projects, "del-nope").project, null, "no match → null");
assert.equal(findOwningProject(projects, "del-nope").ambiguous, false);
const dupes = { a: { links: { deliveryId: "del-d" } }, b: { links: { deliveryId: "del-d" } } };
assert.equal(findOwningProject(dupes, "del-d").project, null, "duplicate → no project (fail closed)");
assert.equal(findOwningProject(dupes, "del-d").ambiguous, true, "duplicate flagged ambiguous");
assert.equal(findOwningProject(null, "del-d").project, null, "null projects safe");

// ── 3. buildAmEnvelope — shape is exactly { accountManager: {5 fields} } ──
const env = buildAmEnvelope(account, editors);
assert.deepEqual(Object.keys(env), ["accountManager"], "only root key is accountManager");
assert.deepEqual(
  Object.keys(env.accountManager).sort(),
  ["bookingUrl", "email", "name", "phone", "photo"],
  "AM block has EXACTLY the five allowed fields",
);
// Editor match wins over account-level fallbacks.
assert.equal(env.accountManager.name, "Jordan Tan");
assert.equal(env.accountManager.email, "jordan@viewix.test");
assert.equal(env.accountManager.photo, "https://x/jordan.jpg");
assert.equal(env.accountManager.bookingUrl, "https://cal/jordan");

// ── 4. Forbidden-key scan (belt-and-braces over the structural check) ──
const FORBIDDEN = ["accountId", "projectId", "dealValue", "producerNotes",
  "attio", "attioId", "links", "editors", "accounts", "projectLead",
  "BRAND_NEW_SECRET_FIELD", "companyName"];
const json = JSON.stringify(env);
for (const bad of FORBIDDEN) {
  assert.ok(!json.includes(bad), `forbidden token "${bad}" leaked into endpoint JSON`);
}

// ── 5. No resolvable account / no AM name → null card ──
assert.deepEqual(buildAmEnvelope(null, editors), { accountManager: null }, "no account → null");
assert.deepEqual(
  buildAmEnvelope({ companyName: "X" }, {}),
  { accountManager: null },
  "account with no AM name → null",
);

// ── 6. Handler rejects before touching the DB (no Firebase needed) ──
function fakeRes() {
  const r = { headers: {}, statusCode: null, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
async function call(method, query) {
  const res = fakeRes();
  await handler({ method, query: query || {}, headers: {}, socket: { remoteAddress: "test-ip" } }, res);
  return res;
}
let r = await call("POST", { deliveryId: "del-111" });
assert.equal(r.statusCode, 405, "non-GET rejected");
r = await call("GET", { deliveryId: "not-valid" });
assert.equal(r.statusCode, 400, "bad deliveryId rejected before DB");
assert.equal(r.headers["Cache-Control"], "no-store", "Cache-Control: no-store always set");

console.log("OK — delivery-am endpoint contract pinned (6 groups passed)");
