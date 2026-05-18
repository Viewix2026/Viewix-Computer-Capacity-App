// Dependency-free allowlist pin for the client redaction layer.
// Run: node api/_clientRedact.test.mjs   (or: npm run test:redact)
//
// Guards the single rule that matters: a sensitive field added to a
// raw record must NOT appear in any client response, because the
// redactor builds projections rather than filtering.

import assert from "node:assert/strict";
import {
  redactProjectListItem, redactProjectDetail,
  accountManagerBlock, derivePhase, deliveryCounts,
} from "./_clientRedact.js";

const FORBIDDEN = [
  "dealValue", "producerNotes", "attioCompanyId", "attioDealId",
  "commissioned", "accountId", "projectLead", "links", "clientContact",
  "BRAND_NEW_SECRET_FIELD",
];

function deepKeys(obj, acc = new Set()) {
  if (Array.isArray(obj)) { obj.forEach(v => deepKeys(v, acc)); return acc; }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) { acc.add(k); deepKeys(v, acc); }
  }
  return acc;
}
function assertNoForbidden(out, label) {
  const keys = deepKeys(out);
  for (const bad of FORBIDDEN) {
    assert.ok(!keys.has(bad), `${label}: forbidden key "${bad}" leaked → ${[...keys].join(",")}`);
  }
}

// Raw records deliberately stuffed with sensitive + future-unknown fields.
const project = {
  id: "proj-123", shortId: "ab12cd34", clientName: "Acme Co",
  projectName: "Spring Campaign", status: "active",
  dealValue: 48000, producerNotes: "internal only", commissioned: true,
  attioCompanyId: "att-1", attioDealId: "deal-9",
  BRAND_NEW_SECRET_FIELD: "should never leak",
  clientContact: { firstName: "Mara", email: "mara@acme.test" },
  links: { accountId: "acct-1", deliveryId: "del-1", preprodId: "social_1", preprodType: "socialOrganic" },
};
const account = {
  id: "acct-1", companyName: "Acme Co", accountManager: "Jordan Tan",
  projectLead: "Internal Lead Name", attioId: "att-1",
  BRAND_NEW_SECRET_FIELD: "nope",
};
const delivery = {
  id: "del-1", shortId: "dd11", videos: [
    { id: "v1", name: "Hero cut", link: "https://x", viewixStatus: "Ready for Review", revision1: "", revision2: "", posted: false },
    { id: "v2", name: "Cutdown", link: "", viewixStatus: "Completed", revision1: "Approved", revision2: "", posted: true },
  ],
};
const preprod = { id: "social_1", shortId: "pp11", status: "approved", companyName: "Acme Co", dealValue: 48000 };

// 1. list item — no forbidden keys, expected shape
const li = redactProjectListItem({ project, account, delivery, preprod });
assertNoForbidden(li, "listItem");
assert.equal(li.projectId, "ab12cd34");           // shortId, not raw id
assert.equal(li.orgName, "Acme Co");
assert.equal(li.projectName, "Spring Campaign");
assert.equal(li.status, "active");
assert.equal(li.counts.total, 2);
assert.equal(li.counts.posted, 1);

// 2. detail — no forbidden keys, deliveries rows only allowed fields
const d = redactProjectDetail({ project, account, delivery, preprod, deliveryUrl: "https://x/d/dd11", preprodUrl: "https://x/p/pp11" });
assertNoForbidden(d, "detail");
const rowKeys = Object.keys(d.deliveries.rows[0]).sort();
assert.deepEqual(rowKeys, ["id", "idx", "link", "n", "posted", "revision1", "revision2", "title", "viewixStatus"]);
assert.equal(d.deliveries.deliveryId, "del-1");
assert.equal(d.preproduction.type, "socialOrganic");
assert.equal(d.preproduction.embeddable, true);

// 3. accountManager block — exactly 5 fields, never projectLead
const am = accountManagerBlock(account);
assert.deepEqual(Object.keys(am).sort(), ["bookingUrl", "email", "name", "phone", "photo"]);
assert.equal(am.name, "Jordan Tan");
assert.equal(am.phone, null);
assert.ok(!JSON.stringify(am).includes("Internal Lead Name"));

// 4. derivePhase sanity
assert.equal(derivePhase({ status: "archived" }, null, null), 3);
assert.equal(derivePhase({ status: "active" }, { videos: [{ viewixStatus: "Ready for Review" }] }, null), 3);
assert.equal(derivePhase({ status: "active" }, { videos: [{ viewixStatus: "In Development" }] }, null), 2);
assert.equal(derivePhase({ status: "active" }, null, { status: "approved" }), 1);
assert.equal(derivePhase({ status: "active" }, null, { status: "draft" }), 0);

// 5. counts
const c = deliveryCounts(delivery.videos);
assert.equal(c.total, 2);
assert.equal(c.ready, 2);
assert.equal(c.approved, 1);

// 6. metaAds preprod → not embeddable
const dMeta = redactProjectDetail({
  project: { ...project, links: { ...project.links, preprodType: "metaAds" } },
  account, delivery, preprod: { ...preprod }, deliveryUrl: null, preprodUrl: "https://x/p/pp11",
});
assert.equal(dMeta.preproduction.type, "metaAds");
assert.equal(dMeta.preproduction.embeddable, false);

console.log("OK — _clientRedact allowlist pinned (6 groups passed)");
