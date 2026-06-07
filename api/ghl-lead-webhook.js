// api/ghl-lead-webhook.js
// Middleware webhook: GoHighLevel Meta-ad lead → three linked Attio records.
//
// When a Meta ad lead lands in GHL as an Opportunity (pipeline
// "2-Step Funnel | Discovery Sessions", source "2-Step Funnel | Meta Ads"),
// the GHL workflow POSTs the opportunity + contact here. We then maintain in
// Attio:
//   1. Company  — deduped by exact name search (search-then-create)
//   2. Person   — upsert by email; existing identity is PRESERVED (never
//                 clobber an existing person's company/contact_type)
//   3. Deal     — keyed by unique `ghl_opportunity_id`: created once with lead
//                 defaults; refires only backfill associations and NEVER reset
//                 live stage/value/owner/source (refire-safe, edit-safe)
//
// Why middleware instead of GHL→Attio direct webhooks:
//   - The Attio API key stays server-side (env), never in GHL.
//   - GHL authenticates with a shared secret only.
//   - We get a durable Firebase attempt log + raw-payload capture for replay.
//   - We can branch on company match-count (GHL can't count array length) and
//     protect existing person identity (GHL upsert can't conditionally write).
//
// Expected payload from the GHL Custom Webhook action (field names flexible —
// map whatever your GHL merge tags emit into these keys):
// {
//   "secret": "<GHL_WEBHOOK_SECRET>",        // or header x-ghl-secret
//   "opportunityId": "{{opportunity.id}}",
//   "businessName":  "{{opportunity.business_name}}",
//   "fullName":      "{{contact.full_name}}",
//   "firstName":     "{{contact.first_name}}",   // optional
//   "lastName":      "{{contact.last_name}}",     // optional
//   "email":         "{{contact.email}}",
//   "phone":         "{{contact.phone}}"          // optional, E.164 (+61…)
// }
//
// Response: 200 { ok, status, companyId, personId, dealId, ... } once the
// attempt is durably logged. We own retries via the Firebase log + Slack
// alert, so we return 200 even on Attio failure to avoid GHL retry storms.
// Only a bad secret (401) or unusable payload (422) are non-200.
//
// CRITICAL (Vercel): the function is frozen the moment it responds, so every
// Attio/Firebase/Slack call is awaited inline — no fire-and-forget.

import crypto from "crypto";
import { adminGet, adminSet, adminPatch, getAdmin, runRtdbTransaction } from "./_fb-admin.js";
import { slackPostMessage } from "./_slack-helpers.js";

const SECRET = process.env.GHL_WEBHOOK_SECRET;
const ATTIO_KEY = process.env.ATTIO_API_KEY;
const ATTIO_BASE = "https://api.attio.com/v2";

// Jeremy's Attio workspace_member_id — Deal owner (actor-reference, required).
const OWNER_MEMBER_ID = "e90aec93-f56e-4f28-8df8-065c63ab1a2d";
const DEAL_STAGE = "Lead";        // status attr, written by title string
const DEAL_SOURCE = "Advertising"; // select attr
const PERSON_CONTACT_TYPE = "Potential Customer"; // only set on NEW people

const SLACK_CHANNEL = process.env.SLACK_SCHEDULE_CHANNEL_ID;
const SLACK_TOKEN = process.env.SLACK_SCHEDULE_BOT_TOKEN;

// ─── Attio REST helpers (raw object value-formats GHL/Attio expect) ─────────
function attioHeaders() {
  return { Authorization: `Bearer ${ATTIO_KEY}`, "Content-Type": "application/json" };
}

async function attioFetch(method, path, body) {
  const resp = await fetch(`${ATTIO_BASE}${path}`, {
    method,
    headers: attioHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { ok: resp.ok, status: resp.status, json, raw: text };
}

// Exact, case/whitespace-sensitive name search. Returns array of record ids
// (up to `limit`). Empty array = no match.
async function queryCompaniesByName(name, limit = 5) {
  const r = await attioFetch("POST", "/objects/companies/records/query", {
    filter: { name },
    limit,
  });
  if (!r.ok) {
    const err = new Error(`Company query failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "FindCompany"; err.statusCode = r.status; throw err;
  }
  return (r.json?.data || []).map(rec => rec?.id?.record_id).filter(Boolean);
}

async function createCompany(name) {
  const r = await attioFetch("POST", "/objects/companies/records", {
    data: { values: { name } },
  });
  if (!r.ok) {
    const err = new Error(`Company create failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "CreateCompany"; err.statusCode = r.status; throw err;
  }
  const id = r.json?.data?.id?.record_id;
  if (!id) { const e = new Error("Company create returned no record_id"); e.step = "CreateCompany"; throw e; }
  return id;
}

// Find an existing person by email (identity-protection: we read first so we
// never overwrite an existing person's company/contact_type via upsert merge).
async function queryPersonByEmail(email) {
  const r = await attioFetch("POST", "/objects/people/records/query", {
    filter: { email_addresses: email },
    limit: 1,
  });
  if (!r.ok) {
    const err = new Error(`Person query failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "FindPerson"; err.statusCode = r.status; throw err;
  }
  return r.json?.data?.[0]?.id?.record_id || null;
}

async function createPerson({ firstName, lastName, fullName, email, phone, companyId }) {
  const values = {
    name: [{ first_name: firstName || "", last_name: lastName || "", full_name: fullName || "" }],
    email_addresses: [email],
    contact_type: PERSON_CONTACT_TYPE,
  };
  // Blank phone would 400 on an empty original_phone_number — omit instead.
  if (phone && String(phone).trim()) {
    values.phone_numbers = [{ original_phone_number: String(phone).trim() }];
  }
  if (companyId) {
    values.company = [{ target_object: "companies", target_record_id: companyId }];
  }
  const r = await attioFetch("POST", "/objects/people/records", { data: { values } });
  if (!r.ok) {
    const err = new Error(`Person create failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "CreatePerson"; err.statusCode = r.status; err.raw = r.raw; throw err;
  }
  const id = r.json?.data?.id?.record_id;
  if (!id) { const e = new Error("Person create returned no record_id"); e.step = "CreatePerson"; throw e; }
  return id;
}

// Look up the single deal carrying this unique ghl_opportunity_id (null = none).
async function queryDealByOpp(opportunityId) {
  const r = await attioFetch("POST", "/objects/deals/records/query", {
    filter: { ghl_opportunity_id: opportunityId },
    limit: 1,
  });
  if (!r.ok) {
    const err = new Error(`Deal query failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "Deal"; err.statusCode = r.status; throw err;
  }
  return r.json?.data?.[0]?.id?.record_id || null;
}

// Create a brand-new deal with the lead defaults.
async function createDeal({ opportunityId, dealName, companyId, personId }) {
  const values = {
    ghl_opportunity_id: opportunityId,
    name: dealName,
    stage: DEAL_STAGE,
    owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: OWNER_MEMBER_ID }],
    source: DEAL_SOURCE,
    value: 0,
  };
  if (companyId) values.associated_company = [{ target_object: "companies", target_record_id: companyId }];
  if (personId) values.associated_people = [{ target_object: "people", target_record_id: personId }];

  const r = await attioFetch("POST", "/objects/deals/records", { data: { values } });
  if (!r.ok) {
    const err = new Error(`Deal create failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "Deal"; err.statusCode = r.status; throw err;
  }
  const id = r.json?.data?.id?.record_id;
  if (!id) { const e = new Error("Deal create returned no record_id"); e.step = "Deal"; throw e; }
  return id;
}

// Refresh an EXISTING deal without touching live pipeline state. Stage, value,
// owner and source are deliberately left alone: once a human (or a later
// automation) has moved this deal forward or set its value, a GHL refire / retry
// / manual replay must never reset it to Lead/A$0. We only backfill the
// company/person associations that may have been missing on the first run. If
// there's nothing new to link, we leave the deal entirely as-is rather than
// firing an empty PATCH.
async function refreshDeal(recordId, { companyId, personId }) {
  const values = {};
  if (companyId) values.associated_company = [{ target_object: "companies", target_record_id: companyId }];
  if (personId) values.associated_people = [{ target_object: "people", target_record_id: personId }];
  if (Object.keys(values).length === 0) return recordId;

  const r = await attioFetch("PATCH", `/objects/deals/records/${recordId}`, { data: { values } });
  if (!r.ok) {
    const err = new Error(`Deal update failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "Deal"; err.statusCode = r.status; throw err;
  }
  return recordId;
}

// Idempotent deal write keyed by the unique ghl_opportunity_id. The same
// opportunity always maps to one deal, but a refire must NOT overwrite live
// pipeline state — so we split create from update instead of a blind PUT-upsert:
//   - no existing deal → create with the lead defaults
//   - existing deal     → refresh associations only (stage/value/owner/source
//                          preserved)
// The query→create window is closed by Attio's uniqueness on
// ghl_opportunity_id: a racing second create hits a uniqueness conflict and we
// recover by re-querying and refreshing the winner — the same idiom as the
// person upsert above.
async function upsertDeal({ opportunityId, dealName, companyId, personId }) {
  const existing = await queryDealByOpp(opportunityId);
  if (existing) {
    return refreshDeal(existing, { companyId, personId });
  }
  try {
    return await createDeal({ opportunityId, dealName, companyId, personId });
  } catch (e) {
    if (isUniqueConflict(e)) {
      const requeried = await queryDealByOpp(opportunityId);
      if (requeried) return refreshDeal(requeried, { companyId, personId });
    }
    throw e;
  }
}

// ─── Company resolution: search-then-create with a transaction lock ─────────
// On 0 matches we create. A best-effort RTDB lock keyed by the normalised
// company name serialises concurrent same-name creates (closes the common
// TOCTOU window). On 1 match we reuse. On 2+ we DON'T guess — we flag for
// manual linking and proceed WITHOUT a company so the lead is never lost and
// never cross-linked to the wrong company.
function nameHash(name) {
  const norm = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

async function resolveCompany(name) {
  const matches = await queryCompaniesByName(name, 5);
  if (matches.length >= 2) {
    return { status: "ambiguous", companyId: null, candidateIds: matches.slice(0, 5) };
  }
  if (matches.length === 1) {
    return { status: "matched", companyId: matches[0] };
  }

  // 0 matches → create, guarded by a name-scoped lock.
  const lockPath = `/ghlLeadSync/companyLocks/${nameHash(name)}`;
  let weHoldLock = false;
  try {
    const tx = await runRtdbTransaction(lockPath, (cur) => {
      if (cur && cur.companyId) return cur;             // peer already created it
      if (cur && cur.status === "creating" && (Date.now() - (cur.ts || 0)) < 30000) {
        return undefined;                               // peer in flight — abort
      }
      return { status: "creating", ts: Date.now() };    // we take the lock
    });
    if (tx.committed && tx.snapshot?.companyId) {
      return { status: "matched", companyId: tx.snapshot.companyId };
    }
    weHoldLock = tx.committed;
    if (!tx.committed) {
      // Lost the lock to a peer mid-create. Re-query once; use their result if
      // present, otherwise fall through and create anyway (peer may have died).
      const recheck = await queryCompaniesByName(name, 5);
      if (recheck.length >= 1) return { status: "matched", companyId: recheck[0] };
    }
  } catch {
    // Lock infra unavailable — degrade to plain create (accepted TOCTOU).
    weHoldLock = false;
  }

  const companyId = await createCompany(name);
  if (weHoldLock) {
    try { await adminPatch(lockPath, { status: "created", companyId, ts: Date.now() }); } catch { /* noop */ }
  }
  return { status: "created", companyId };
}

// ─── Firebase durable log ───────────────────────────────────────────────────
// Keyed by opportunity id (RTDB-safe? GHL opportunity ids are alphanumeric —
// hash to be safe against `. # $ / [ ]`). Stores raw payload for replay.
function logKey(opportunityId) {
  return crypto.createHash("sha256").update(String(opportunityId)).digest("hex").slice(0, 24);
}

// `strict: true` makes the write throw on any failure (missing Firebase config
// OR a rejected patch). The Attio-failure path uses it: we only suppress GHL's
// retry (return 200) if we KNOW the lead is durably recorded for replay. If the
// log can't be written, the lead must not silently vanish — we surface the
// failure so the caller can let GHL retry instead.
async function writeLog(opportunityId, data, { strict = false } = {}) {
  const { err } = getAdmin();
  if (err) {
    if (strict) throw new Error(`Durable log unavailable: ${err}`);
    return; // best-effort: no Firebase configured — don't fail the lead
  }
  const path = `/ghlLeadSync/attempts/${logKey(opportunityId)}`;
  if (strict) {
    await adminPatch(path, data); // let it throw — caller decides retry policy
    return;
  }
  try { await adminPatch(path, data); } catch { /* best-effort */ }
}

// Attio rejects a duplicate unique value (e.g. a second person with the same
// email) — surfaced as 409 or a uniqueness message. We treat that as a
// recoverable race, not a hard failure.
function isUniqueConflict(e) {
  if (e?.statusCode === 409) return true;
  const m = (e?.message || "").toLowerCase();
  return m.includes("uniqueness") || m.includes("already exists")
    || m.includes("not unique") || m.includes("value_already_exists");
}

// ─── Slack alerts ────────────────────────────────────────────────────────────
async function slackAlert(text) {
  if (!SLACK_CHANNEL || !SLACK_TOKEN) return;
  try {
    await slackPostMessage({ channel: SLACK_CHANNEL, text, botToken: SLACK_TOKEN });
  } catch (e) {
    console.error("ghl-lead-webhook: Slack alert failed:", e.message);
  }
}

const companyUrl = (id) => `https://app.attio.com/viewix/company/${id}`;

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-ghl-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!SECRET) return res.status(500).json({ error: "GHL_WEBHOOK_SECRET not configured" });
  if (!ATTIO_KEY) return res.status(500).json({ error: "ATTIO_API_KEY not configured" });

  const body = req.body || {};
  const providedSecret = body.secret || req.headers["x-ghl-secret"];
  if (providedSecret !== SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }

  // Normalise inbound fields (trim everything; GHL merge tags can carry stray
  // whitespace which would break the exact company name match).
  const opportunityId = String(body.opportunityId || body.opportunity_id || "").trim();
  const businessName = String(body.businessName || body.business_name || "").trim();
  const fullName = String(body.fullName || body.full_name || "").trim();
  const firstName = String(body.firstName || body.first_name || "").trim();
  const lastName = String(body.lastName || body.last_name || "").trim();
  const email = String(body.email || "").trim();
  const phone = String(body.phone || "").trim();
  const dealName = `${fullName || email || "Lead"} - ${businessName || "Unknown"}`;

  // ── Phase 1.5 preflight hard-stop ──
  // Guards the PLUMBING, not the Meta form. A mistyped merge tag, a broken GHL
  // mapping, or a manual opportunity dropped in this pipeline all produce a
  // blank value — and a blank value collapses records (every blank-email lead
  // overwrites one empty person, blank opp-id overwrites one empty deal, blank
  // name makes one junk company). One check prevents all three.
  const missing = [];
  if (!opportunityId) missing.push("opportunityId");
  if (!businessName) missing.push("businessName");
  if (!email) missing.push("email");
  if (missing.length) {
    await slackAlert(
      `🚨 GHL→Attio lead rejected — missing required field(s): *${missing.join(", ")}*\n`
      + `Business: ${businessName || "—"} · Email: ${email || "—"} · Opp ID: ${opportunityId || "—"}\n`
      + `_Check the GHL workflow merge-tag mapping._`,
    );
    if (opportunityId) await writeLog(opportunityId, {
      opportunityId, status: "rejected", reason: `missing: ${missing.join(",")}`,
      payload: body, updatedAt: new Date().toISOString(),
    });
    return res.status(422).json({ ok: false, error: "Missing required field(s)", missing });
  }

  // Durable "pending" record up front so a mid-flight crash is still visible/replayable.
  await writeLog(opportunityId, {
    opportunityId, businessName, email, fullName, status: "pending",
    payload: body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  let companyId = null, personId = null, dealId = null, companyStatus = null;
  try {
    // ── Phase 2: Company ──
    const company = await resolveCompany(businessName);
    companyStatus = company.status;
    companyId = company.companyId;
    if (company.status === "ambiguous") {
      const links = company.candidateIds.map(id => `<${companyUrl(id)}|${id}>`).join("  ·  ");
      await slackAlert(
        `⚠️ GHL→Attio: *${company.candidateIds.length}+ companies* match "${businessName}" — manual link needed.\n`
        + `Lead captured WITHOUT a company link (person + deal still created).\n`
        + `Candidates: ${links}\n`
        + `Contact: ${fullName} · ${email} · Opp ID: ${opportunityId}`,
      );
    }

    // ── Phase 3: Person (identity-protecting upsert) ──
    // Read first: if the email already exists, reuse that person untouched so
    // we never downgrade a Current Customer to "Potential Customer" or move
    // them off their real company. Only brand-new emails get the full create.
    const existingPerson = await queryPersonByEmail(email);
    if (existingPerson) {
      personId = existingPerson;
    } else {
      try {
        personId = await createPerson({ firstName, lastName, fullName, email, phone, companyId });
      } catch (e) {
        // Concurrent same-(new)-email race: both requests saw no person and
        // both tried to create; the loser hits the email uniqueness conflict.
        // Recover by re-querying — the winner's record now exists — so this
        // opportunity still gets its deal instead of being dropped.
        if (isUniqueConflict(e)) {
          const requeried = await queryPersonByEmail(email);
          if (requeried) personId = requeried;
          else throw e;
        } else {
          throw e;
        }
      }
    }

    // ── Phase 4: Deal (upsert by unique ghl_opportunity_id) ──
    dealId = await upsertDeal({ opportunityId, dealName, companyId, personId });

    await writeLog(opportunityId, {
      status: "synced", companyId, personId, dealId, companyStatus,
      reusedPerson: !!existingPerson, error: null, updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true, status: "synced", companyId, personId, dealId, companyStatus,
    });
  } catch (e) {
    const step = e.step || "Unknown";
    const statusCode = e.statusCode || null;
    console.error(`ghl-lead-webhook failed at ${step}:`, e);

    // Retry ownership only holds if the failure is durably recorded. Write the
    // failure log STRICTLY: if it succeeds we can safely 200 (suppress GHL
    // retry, we'll replay). If even the log write fails — Firebase down or
    // misconfigured — we must NOT swallow the lead: 502 so GHL retries.
    //
    // The strict record carries the full payload + normalised fields so it is
    // self-sufficient for replay. The up-front "pending" write is best-effort,
    // so if it silently failed (transient Firebase blip) this is the only
    // durable copy — it must contain everything a replay needs, not just ids.
    let logged = false;
    try {
      await writeLog(opportunityId, {
        opportunityId, businessName, email, fullName, payload: body,
        status: "failed", failedStep: step, statusCode,
        companyId, personId, dealId, error: e.message, updatedAt: new Date().toISOString(),
      }, { strict: true });
      logged = true;
    } catch (logErr) {
      console.error("ghl-lead-webhook: durable failure log FAILED:", logErr);
    }

    await slackAlert(
      `🚨 GHL→Attio sync failure — step: *${step}*${statusCode ? ` (HTTP ${statusCode})` : ""}\n`
      + `Contact: ${fullName} · Business: ${businessName} · Email: ${email}\n`
      + `Resolved so far: company=${companyId || "—"} person=${personId || "—"} deal=${dealId || "—"}\n`
      + `Error: ${e.message}\n`
      + `Opp ID: ${opportunityId} — ${logged ? "logged for replay." : "⚠️ DURABLE LOG FAILED — asking GHL to retry."}`,
    );

    if (logged) {
      // Durably recorded → suppress GHL retry-storm; we own the replay.
      return res.status(200).json({ ok: false, status: "failed", step, error: e.message });
    }
    // No durable record → let GHL retry rather than lose the lead silently.
    return res.status(502).json({ ok: false, status: "failed", step, error: e.message, durableLog: false });
  }
}
