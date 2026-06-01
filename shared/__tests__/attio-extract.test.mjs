// Pure unit tests for shared/attio-extract.js
// Run via:  node shared/__tests__/attio-extract.test.mjs
// No test runner — assertions throw on failure, green summary on success.

import assert from "node:assert/strict";
import {
  extractVal,
  extractStage,
  extractDealName,
  extractDealCompanyId,
  dealRecordId,
  isWonStage,
  normName,
  buildDealIndex,
  resolveDealValue,
} from "../attio-extract.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// Raw Attio deal record, shaped like /attioCache.data entries.
function deal({ id, name, value, stage = "Won", companyId = null, closeDate = "2026-05-01", currencyKey = "currency_value" }) {
  const v = {
    name: name == null ? undefined : [{ value: name }],
    stage: [{ status: { title: stage } }],
    close_date: [{ value: closeDate }],
  };
  if (value != null) v.value = [{ [currencyKey]: value, currency_code: "AUD" }];
  if (companyId) v.associated_company = [{ target_record_id: companyId, target_object: "companies" }];
  return { id: { record_id: id }, values: v };
}

// ── raw-cell extractors ──────────────────────────────────────────────
test("extractVal: reads currency_value, falls back to value, else 0", () => {
  assert.equal(extractVal(deal({ id: "d", name: "x", value: 3695 })), 3695);
  assert.equal(extractVal(deal({ id: "d", name: "x", value: 50, currencyKey: "value" })), 50);
  assert.equal(extractVal({ values: {} }), 0);
});

test("extractVal: parses stringified/formatted currency safely (no parseFloat truncation)", () => {
  // a naive parseFloat("3,695.00") returns 3 — must not attach $3 of revenue
  assert.equal(extractVal(deal({ id: "d", name: "x", value: "3,695.00" })), 3695);
  assert.equal(extractVal(deal({ id: "d", name: "x", value: "A$3,695.00" })), 3695);
  assert.equal(extractVal(deal({ id: "d", name: "x", value: "not a number" })), 0);
});

test("extractStage: lowercases; isWonStage true for Won/Closed Won, false for Lost/Lead", () => {
  assert.equal(extractStage(deal({ id: "d", name: "x", value: 1, stage: "Won" })), "won");
  assert.equal(isWonStage("won"), true);
  assert.equal(isWonStage("closed won"), true);
  assert.equal(isWonStage("completed"), true);
  assert.equal(isWonStage("lead"), false);
  assert.equal(isWonStage("lost"), false);
  // the bare substring "closed" must NOT make "closed lost" count as won
  assert.equal(isWonStage("closed lost"), false);
  // WORD-BOUNDARY guard: a "won/signed/completed" substring inside a negated
  // word must NOT read as won, or a non-won deal's revenue would be indexed.
  assert.equal(isWonStage("unsigned"), false);
  assert.equal(isWonStage("un-signed"), false);
  assert.equal(isWonStage("not signed"), false);
  assert.equal(isWonStage("uncompleted"), false);
});

test("extractDealName / company id / record id", () => {
  const d = deal({ id: "deal-1", name: "Brand Movie", value: 1000, companyId: "co-9" });
  assert.equal(extractDealName(d), "Brand Movie");
  assert.equal(extractDealCompanyId(d), "co-9");
  assert.equal(dealRecordId(d), "deal-1");
});

test("normName: trims, lowercases, collapses whitespace", () => {
  assert.equal(normName("  Bathurst   Station  "), "bathurst station");
  assert.equal(normName(null), "");
});

// ── buildDealIndex ───────────────────────────────────────────────────
test("buildDealIndex: indexes only Won deals with positive value, keyed by name", () => {
  const cache = { data: [
    deal({ id: "d1", name: "Snowy 2.0 Campaign", value: 36406, stage: "Won", companyId: "co-snowy" }),
    deal({ id: "d2", name: "Lost One", value: 5000, stage: "Lost", companyId: "co-x" }),       // not won
    deal({ id: "d3", name: "Zero Deal", value: 0, stage: "Won", companyId: "co-y" }),           // no value
    deal({ id: "d4", name: "Lead Thing", stage: "Lead", companyId: "co-z" }),                   // no value, not won
  ] };
  const idx = buildDealIndex(cache);
  assert.equal(idx.byName.size, 1);
  assert.deepEqual(idx.byName.get("snowy 2.0 campaign")[0].value, 36406);
  assert.equal(idx.byName.get("snowy 2.0 campaign")[0].recordId, "d1");
});

test("buildDealIndex: null/empty cache => empty index, no throw", () => {
  assert.equal(buildDealIndex(null).byName.size, 0);
  assert.equal(buildDealIndex({ data: null }).byName.size, 0);
  assert.equal(buildDealIndex({}).byName.size, 0);
});

test("buildDealIndex: skips a Won deal with no record id (unattributable, can't dedupe)", () => {
  const cache = { data: [
    { id: {}, values: { name: [{ value: "No Id Deal" }], value: [{ currency_value: 5000 }], stage: [{ status: { title: "Won" } }] } },
  ] };
  assert.equal(buildDealIndex(cache).byName.size, 0);
});

// ── resolveDealValue ─────────────────────────────────────────────────
const IDX = buildDealIndex({ data: [
  deal({ id: "d-uniq", name: "Corporate video for Spanish translation", value: 672, companyId: "co-ausimm" }),
  // two deals share the SAME name but different companies
  deal({ id: "d-brand-a", name: "Brand Video", value: 8000, companyId: "co-a" }),
  deal({ id: "d-brand-b", name: "Brand Video", value: 12000, companyId: "co-b" }),
] });

test("resolveDealValue: unique name match returns value + dealId, not ambiguous", () => {
  const r = resolveDealValue({ projectName: "Corporate video for Spanish translation" }, IDX);
  assert.equal(r.value, 672);
  assert.equal(r.dealId, "d-uniq");
  assert.equal(r.ambiguous, false);
});

test("resolveDealValue: case/whitespace-insensitive match", () => {
  const r = resolveDealValue({ projectName: "  corporate VIDEO for   spanish translation " }, IDX);
  assert.equal(r.value, 672);
});

test("resolveDealValue: single match + MATCHING company still resolves", () => {
  const r = resolveDealValue({ projectName: "Corporate video for Spanish translation", attioCompanyId: "co-ausimm" }, IDX);
  assert.equal(r.value, 672);
  assert.equal(r.dealId, "d-uniq");
});

test("resolveDealValue: single name match but project's company DISAGREES => no value (some other client's deal)", () => {
  const r = resolveDealValue({ projectName: "Corporate video for Spanish translation", attioCompanyId: "co-someone-else" }, IDX);
  assert.equal(r.value, null);
  assert.equal(r.dealId, null);
  assert.equal(r.ambiguous, false);
});

test("resolveDealValue: name collision disambiguated by company id", () => {
  const r = resolveDealValue({ projectName: "Brand Video", attioCompanyId: "co-b" }, IDX);
  assert.equal(r.value, 12000);
  assert.equal(r.dealId, "d-brand-b");
  assert.equal(r.ambiguous, false);
});

test("resolveDealValue: name collision + no/unknown company => ambiguous, no number guessed", () => {
  const noCo = resolveDealValue({ projectName: "Brand Video" }, IDX);
  assert.equal(noCo.value, null);
  assert.equal(noCo.ambiguous, true);
  const unknownCo = resolveDealValue({ projectName: "Brand Video", attioCompanyId: "co-nope" }, IDX);
  assert.equal(unknownCo.value, null);
  assert.equal(unknownCo.ambiguous, true);
});

test("resolveDealValue: no candidate => null; blank name => null", () => {
  assert.equal(resolveDealValue({ projectName: "Does Not Exist" }, IDX), null);
  assert.equal(resolveDealValue({ projectName: "" }, IDX), null);
  assert.equal(resolveDealValue({ projectName: "x" }, null), null);
});

console.log(`\n${passed} passed`);
