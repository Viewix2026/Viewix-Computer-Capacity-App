// Tests for computeFoundersMetrics activeClients (company-identity fix).
// Run: node --test api/__tests__/attio-metrics.test.mjs
//
// The bug: activeClients counted `values.name` (the DEAL TITLE), so every
// deal looked like a new client (256 deals -> "250 clients"). The fix counts
// DISTINCT companies by `associated_company` id, scoped to Won deals in the
// last 3 calendar months.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFoundersMetrics, extractCompanyId } from "../_attio-metrics.js";

const NOW = new Date("2026-06-30T00:00:00Z"); // fixed clock; 90d ago ~ 2026-03-31

function deal({ title, companyId, stage = "Won", date = "2026-06-01", value = 5000 }) {
  const values = {
    name: [{ value: title, attribute_type: "text" }],
    stage: [{ status: { title: stage } }],
    close_date: [{ value: date }],
    value: [{ currency_value: value }],
  };
  if (companyId) {
    values.associated_company = [{ target_object: "companies", target_record_id: companyId }];
  }
  return { id: { record_id: `deal-${title}` }, values };
}

test("extractCompanyId reads associated_company id, ignores deal title", () => {
  assert.equal(extractCompanyId(deal({ title: "Big Brand Hero Video", companyId: "co-abc" })), "co-abc");
  assert.equal(extractCompanyId(deal({ title: "No company linked" })), null);
});

test("REGRESSION: two Won deals for the SAME company count as ONE active client", () => {
  // Pre-fix this returned 2 (two different deal titles). Post-fix: 1 company.
  const deals = [
    deal({ title: "Masterton FY25-26 SOW", companyId: "co-masterton" }),
    deal({ title: "Masterton Brand Movie", companyId: "co-masterton" }),
  ];
  const m = computeFoundersMetrics(deals, NOW);
  assert.equal(m.activeClients, 1);
});

test("distinct companies are counted distinctly", () => {
  const deals = [
    deal({ title: "A1", companyId: "co-a" }),
    deal({ title: "A2", companyId: "co-a" }),
    deal({ title: "B1", companyId: "co-b" }),
    deal({ title: "C1", companyId: "co-c" }),
  ];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 3);
});

test("Won deals older than 3 months do NOT count as active clients", () => {
  const deals = [
    deal({ title: "Stale win", companyId: "co-old", date: "2025-12-01" }),
    deal({ title: "Fresh win", companyId: "co-new", date: "2026-06-15" }),
  ];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 1);
});

// --- Round 1 Codex findings: stage keyword + window + casing ---

test("F1: 'Closed Lost' is NOT counted as won (no bare 'closed' keyword)", () => {
  const deals = [
    deal({ title: "Lost big", companyId: "co-lost", stage: "Closed Lost", value: 9000, date: "2026-06-01" }),
  ];
  const m = computeFoundersMetrics(deals, NOW);
  assert.equal(m.activeClients, 0);
  assert.equal(m.ytdRevenue, 0);        // must not leak into revenue
  assert.equal(m.closingRate, 0);       // 0 won of 1 closed
});

test("F1: 'closed-lost' (hyphen, lowercased) is NOT counted as won", () => {
  const deals = [deal({ title: "Lost hyphen", companyId: "co-l2", stage: "closed-lost", value: 4000 })];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 0);
});

test("F1: 'Closed Won' IS still counted as won (caught by 'won')", () => {
  const deals = [deal({ title: "Big close", companyId: "co-w", stage: "Closed Won", value: 8000, date: "2026-06-01" })];
  const m = computeFoundersMetrics(deals, NOW);
  assert.equal(m.activeClients, 1);
  assert.equal(m.ytdRevenue, 8000);
});

test("F4: live lowercase stage 'won' is matched", () => {
  // Viewix's live Attio stages are lowercase single words ("won"/"lost").
  const deals = [deal({ title: "Live shape", companyId: "co-live", stage: "won", date: "2026-06-01" })];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 1);
});

test("F4: same company on a Won AND an Open deal counts once", () => {
  const deals = [
    deal({ title: "Retainer won", companyId: "co-dup", stage: "Won", date: "2026-06-01" }),
    deal({ title: "Upsell pitch", companyId: "co-dup", stage: "Quoted" }),
  ];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 1);
});

test("F4: window wraps the year correctly when now is in February", () => {
  // now = Feb 2026; 3 months back = Nov 2025. A Dec-2025 win is in-window,
  // a Sep-2025 win is out. Guards against setMonth year-underflow regressions.
  const febNow = new Date("2026-02-15T00:00:00Z");
  const deals = [
    deal({ title: "Dec win", companyId: "co-dec", date: "2025-12-20" }),
    deal({ title: "Sep win", companyId: "co-sep", date: "2025-09-10" }),
  ];
  assert.equal(computeFoundersMetrics(deals, febNow).activeClients, 1);
});

test("Open and Lost deals never count toward active clients", () => {
  const deals = [
    deal({ title: "Open pitch", companyId: "co-open", stage: "Quoted" }),
    deal({ title: "Lost pitch", companyId: "co-lost", stage: "Lost" }),
  ];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 0);
});

test("Won deal with no linked company is skipped, not counted under its title", () => {
  const deals = [
    deal({ title: "Orphan win", date: "2026-06-10" }), // no companyId
    deal({ title: "Linked win", companyId: "co-x", date: "2026-06-10" }),
  ];
  assert.equal(computeFoundersMetrics(deals, NOW).activeClients, 1);
});

test("other metrics still compute: pipeline from open deals, ytd from won", () => {
  const deals = [
    deal({ title: "Won A", companyId: "co-a", value: 10000, date: "2026-05-01" }),
    deal({ title: "Open B", companyId: "co-b", stage: "Quoted", value: 7000 }),
    deal({ title: "Lost C", companyId: "co-c", stage: "Lost", value: 3000 }),
  ];
  const m = computeFoundersMetrics(deals, NOW);
  assert.equal(m.leadPipelineValue, 7000); // only the open deal
  assert.equal(m.ytdRevenue, 10000);       // only the won deal, this calendar year
  assert.equal(m.activeClients, 1);        // only the recent won company
});
