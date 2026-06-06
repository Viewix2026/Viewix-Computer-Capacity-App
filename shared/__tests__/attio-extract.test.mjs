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
  parseVideoCount,
  extractNumberOfVideos,
  extractDealPersonId,
  extractPersonEmail,
  extractPersonFirstName,
  resolveDeal,
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

test("extractStage + isWonStage: only 'won' is won across the real Viewix pipeline", () => {
  assert.equal(extractStage(deal({ id: "d", name: "x", value: 1, stage: "Won" })), "won");
  // the six real Attio stages (verified 2026-06-01): only Won is won
  assert.equal(isWonStage("won"), true);
  assert.equal(isWonStage("lead"), false);
  assert.equal(isWonStage("meeting booked"), false);
  assert.equal(isWonStage("quoted"), false);
  assert.equal(isWonStage("on hold"), false);
  assert.equal(isWonStage("lost"), false);
  // rename-robust: a future "Closed Won" still resolves as won
  assert.equal(isWonStage("closed won"), true);
  // negation guard: a "won" compound that is explicitly not-won stays false
  assert.equal(isWonStage("not won"), false);
  // the bare substring "closed" must NOT make "closed lost" count as won
  assert.equal(isWonStage("closed lost"), false);
  // 'completed' / 'signed' are NOT Viewix won states; they must not match
  assert.equal(isWonStage("completed"), false);
  assert.equal(isWonStage("signed"), false);
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

test("buildDealIndex: SAME record id twice (cache dup) => ONE candidate, resolves (not a fake tie)", () => {
  // A pagination overlap in api/sync-attio-cache.js can drop the SAME deal
  // record into /attioCache.data twice. It must not look like a name
  // collision — that would wrongly flag an otherwise-clean project Incomplete.
  const cache = { data: [
    deal({ id: "dup-1", name: "Highway Upgrade Film", value: 9000, companyId: "co-rms" }),
    deal({ id: "dup-1", name: "Highway Upgrade Film", value: 9000, companyId: "co-rms" }),
  ] };
  const idx = buildDealIndex(cache);
  assert.equal(idx.byName.get("highway upgrade film").length, 1);
  const r = resolveDealValue({ projectName: "Highway Upgrade Film" }, idx);
  assert.equal(r.value, 9000);
  assert.equal(r.dealId, "dup-1");
  assert.equal(r.ambiguous, false);
});

test("buildDealIndex: same name across DIFFERENT record ids stays a real collision (ambiguous)", () => {
  // The dedupe keys on record id, not name: two genuinely different deals
  // that share a name must still produce >1 candidate so resolveDealValue
  // refuses to guess.
  const cache = { data: [
    deal({ id: "diff-a", name: "Highway Upgrade Film", value: 9000, companyId: "co-a" }),
    deal({ id: "diff-b", name: "Highway Upgrade Film", value: 15000, companyId: "co-b" }),
  ] };
  const idx = buildDealIndex(cache);
  assert.equal(idx.byName.get("highway upgrade film").length, 2);
  const r = resolveDealValue({ projectName: "Highway Upgrade Film" }, idx);
  assert.equal(r.value, null);
  assert.equal(r.ambiguous, true);
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

// ── foreign-key (deal record id) matching ────────────────────────────
// Real-world: api/webhook-deal-won.js stores the won deal's record id in the
// project's `attioCompanyId` field (Zapier mislabels the deal id as companyId).
// The id index must match on that, and it must WIN over the name+company path —
// otherwise the company guard rejects the project's own deal (its attioCompanyId
// equals the deal id, never the company id) and zeroes a real sale.
test("buildDealIndex: builds byRecordId, including a nameless Won deal", () => {
  const idx = buildDealIndex({ data: [
    deal({ id: "d-1", name: "Named Deal", value: 100 }),
    deal({ id: "d-2", name: null, value: 200 }), // nameless: dropped by byName, kept by byRecordId
  ] });
  assert.equal(idx.byRecordId.size, 2);
  assert.equal(idx.byRecordId.get("d-2").value, 200);
  assert.equal(idx.byName.has(""), false); // nameless not indexed by name
});

test("resolveDealValue: FK match on attioCompanyId (= deal record id) wins over the company guard", () => {
  // projectName matches d-uniq by name, but attioCompanyId holds that deal's
  // OWN record id (not co-ausimm). Pre-fix the guard rejected this (co != id);
  // the FK path must resolve it to the deal's value.
  const r = resolveDealValue({ projectName: "Corporate video for Spanish translation", attioCompanyId: "d-uniq" }, IDX);
  assert.equal(r.value, 672);
  assert.equal(r.dealId, "d-uniq");
  assert.equal(r.ambiguous, false);
});

test("resolveDealValue: FK match resolves even with a blank/non-matching projectName", () => {
  const blank = resolveDealValue({ projectName: "", attioCompanyId: "d-uniq" }, IDX);
  assert.equal(blank.value, 672);
  assert.equal(blank.dealId, "d-uniq");
  const wrongName = resolveDealValue({ projectName: "Totally Different Name", attioCompanyId: "d-brand-b" }, IDX);
  assert.equal(wrongName.value, 12000);
  assert.equal(wrongName.dealId, "d-brand-b");
});

test("resolveDealValue: attioDealId is preferred as the FK when present", () => {
  const r = resolveDealValue({ projectName: "noise", attioDealId: "d-uniq", attioCompanyId: "co-ausimm" }, IDX);
  assert.equal(r.dealId, "d-uniq");
  assert.equal(r.value, 672);
});

test("resolveDealValue: a genuine company id never FK-false-matches (falls through to name path)", () => {
  // co-b is a real company id (it's d-brand-b's company) but NOT a deal record
  // id, so it must miss byRecordId and resolve via the name+company collision
  // path — exactly the pre-existing behaviour, unchanged.
  const r = resolveDealValue({ projectName: "Brand Video", attioCompanyId: "co-b" }, IDX);
  assert.equal(r.value, 12000);
  assert.equal(r.dealId, "d-brand-b");
});

test("resolveDealValue: no candidate => null; blank name => null", () => {
  assert.equal(resolveDealValue({ projectName: "Does Not Exist" }, IDX), null);
  assert.equal(resolveDealValue({ projectName: "" }, IDX), null);
  assert.equal(resolveDealValue({ projectName: "x" }, null), null);
});

// ── carry-across: parseVideoCount ────────────────────────────────────
test("parseVideoCount: parses, preserves 0, clamps, rejects junk", () => {
  assert.equal(parseVideoCount("5"), 5);
  assert.equal(parseVideoCount(5), 5);
  assert.equal(parseVideoCount(0), 0);          // explicit 0 preserved (was lost by `|| null`)
  assert.equal(parseVideoCount("0"), 0);
  assert.equal(parseVideoCount(5.9), 5);         // floored
  assert.equal(parseVideoCount("12 videos"), 12); // strips trailing text
  assert.equal(parseVideoCount(999), 500);       // clamped to ceiling
  assert.equal(parseVideoCount(-3), 0);          // clamped to floor
  assert.equal(parseVideoCount(""), null);
  assert.equal(parseVideoCount("  "), null);
  assert.equal(parseVideoCount(undefined), null);
  assert.equal(parseVideoCount(null), null);
  assert.equal(parseVideoCount("abc"), null);
});

// ── carry-across: extractNumberOfVideos (distinguishes 0 from absent) ──
test("extractNumberOfVideos: number incl 0, null when attribute absent", () => {
  assert.equal(extractNumberOfVideos({ values: { number_of_videos: [{ value: 9 }] } }), 9);
  assert.equal(extractNumberOfVideos({ values: { number_of_videos: [{ value: 0 }] } }), 0);
  assert.equal(extractNumberOfVideos({ values: {} }), null);
  assert.equal(extractNumberOfVideos({ values: { number_of_videos: [] } }), null);
});

// ── carry-across: extractDealPersonId (single-person guard) ───────────
test("extractDealPersonId: returns id only for exactly ONE associated person", () => {
  const one = { values: { associated_people: [{ target_record_id: "person-1" }] } };
  assert.equal(extractDealPersonId(one), "person-1");
  const none = { values: { associated_people: [] } };
  assert.equal(extractDealPersonId(none), null);
  const many = { values: { associated_people: [{ target_record_id: "a" }, { target_record_id: "b" }] } };
  assert.equal(extractDealPersonId(many), null); // never guess which contact
  assert.equal(extractDealPersonId({ values: {} }), null);
});

// ── carry-across: person extractors ──────────────────────────────────
test("extractPersonEmail / extractPersonFirstName: present, absent, mononym", () => {
  const p = { values: { email_addresses: [{ email_address: " raj@x.com " }], name: [{ first_name: "Raj", full_name: "Raj Pandita" }] } };
  assert.equal(extractPersonEmail(p), "raj@x.com");
  assert.equal(extractPersonFirstName(p), "Raj");
  // no first_name -> first token of full_name
  const f = { values: { name: [{ full_name: "Alan Hollensen" }] } };
  assert.equal(extractPersonFirstName(f), "Alan");
  // mononym -> whole name
  const m = { values: { name: [{ full_name: "Cher" }] } };
  assert.equal(extractPersonFirstName(m), "Cher");
  // absent
  assert.equal(extractPersonEmail({ values: {} }), null);
  assert.equal(extractPersonFirstName({ values: {} }), null);
});

// ── carry-across: buildDealIndex includeZeroValue + new entry fields ──
test("buildDealIndex includeZeroValue: indexes a $0 Won deal; default excludes it", () => {
  const zeroDeal = {
    id: { record_id: "z1" },
    values: {
      name: [{ value: "Footage Only Shoot" }],
      stage: [{ status: { title: "Won" } }],
      value: [{ currency_value: 0 }],
      number_of_videos: [{ value: 0 }],
      associated_people: [{ target_record_id: "person-9" }],
    },
  };
  // default: value-gated -> excluded (profitability semantics unchanged)
  assert.equal(buildDealIndex({ data: [zeroDeal] }).byName.size, 0);
  // includeZeroValue: indexed, carrying numberOfVideos + personId
  const idx = buildDealIndex({ data: [zeroDeal] }, { includeZeroValue: true });
  const entry = idx.byName.get("footage only shoot")[0];
  assert.equal(entry.numberOfVideos, 0);
  assert.equal(entry.personId, "person-9");
  assert.equal(entry.recordId, "z1");
});

// ── carry-across: resolveDeal ────────────────────────────────────────
const CARRY_IDX = buildDealIndex({ data: [
  deal({ id: "c-uniq", name: "Spanish Translation Video", value: 672, companyId: "co-1" }),
  deal({ id: "c-a", name: "Shared Name", value: 8000, companyId: "co-a" }),
  deal({ id: "c-b", name: "Shared Name", value: 12000, companyId: "co-b" }),
] }, { includeZeroValue: true });

test("resolveDeal: confident match returns the entry + dealId", () => {
  const r = resolveDeal({ projectName: "Spanish Translation Video" }, CARRY_IDX);
  assert.equal(r.dealId, "c-uniq");
  assert.equal(r.ambiguous, false);
  assert.equal(r.entry.recordId, "c-uniq");
});

test("resolveDeal: tie => ambiguous, no entry; mismatch/none => null", () => {
  const tie = resolveDeal({ projectName: "Shared Name" }, CARRY_IDX);
  assert.equal(tie.ambiguous, true);
  assert.equal(tie.entry, null);
  // cross-client name collision (single candidate, company disagrees) => null
  assert.equal(resolveDeal({ projectName: "Spanish Translation Video", attioCompanyId: "co-other" }, CARRY_IDX), null);
  // no candidate => null
  assert.equal(resolveDeal({ projectName: "Nope" }, CARRY_IDX), null);
});

console.log(`\n${passed} passed`);
