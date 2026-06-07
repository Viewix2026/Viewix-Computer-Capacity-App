// api/ghl-lead-webhook.js
// Middleware webhook: GoHighLevel Meta-ad lead → three linked Attio records.
//
// When a Meta/Social lead completes a funnel survey in GHL, the workflow's
// Webhook action POSTs the CONTACT here (the survey trigger gives a contact, not
// an opportunity — there is no opportunity id). We then maintain in Attio:
//   1. Company  — deduped by exact name search (search-then-create); OPTIONAL,
//                 only when the payload carries a company name
//   2. Person   — upsert by email; existing identity is PRESERVED (never
//                 clobber an existing person's company/contact_type)
//   3. Deal     — keyed by unique `ghl_contact_id` (one deal per contact):
//                 created at Lead; refires backfill associations and advance the
//                 stage FORWARD-ONLY, never resetting live stage/value/owner/source
//
// Why middleware instead of GHL→Attio direct webhooks:
//   - The Attio API key stays server-side (env), never in GHL.
//   - GHL authenticates with a shared secret only.
//   - We get a durable Firebase attempt log + raw-payload capture for replay.
//   - We adapt GHL's native payload shape and protect existing person identity
//     (a GHL upsert can't conditionally write).
//
// GHL's workflow Webhook sends the contact's standard fields at the TOP LEVEL
// (snake_case) and any custom rows nested under `customData`. Real payload:
// {
//   "contact_id": "TaYkOp8F9qB0mzhZXW9M",   // → dedup key (ghl_contact_id)
//   "full_name":  "Con Koumoulas",
//   "email":      "lead@example.com",
//   "phone":      "+61419617571",            // present when set
//   "company_name": "Water World Pty Ltd",   // present when set → Company
//   "customData": { "secret": "…", "stage": "Meeting Booked" }  // stage on STEP 2
// }
// (Auth secret + the optional stage live under customData; everything else is
// read with snake_case-first, camelCase fallback.)
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
const DEAL_STAGE = "Lead";        // status attr, written by title string; default on create
const DEAL_SOURCE = "Advertising"; // select attr
const PERSON_CONTACT_TYPE = "Potential Customer"; // only set on NEW people

// Deal pipeline stages in pipeline order (from the live Attio schema). The rank
// drives FORWARD-ONLY stage moves: a webhook may advance a deal (e.g. STEP 2
// "Meeting Booked" lifts a "Lead"), but may NEVER pull it backwards — a deal the
// sales team moved to Quoted/Won, or a repeated STEP 2 reminder, can't regress.
const STAGE_RANK = {
  "Lead": 1,
  "Meeting Booked": 2,
  "Quoted": 3,
  "On Hold": 4,
  "Won": 5,
  "Lost": 6,
};

// Validate a requested stage title against the known pipeline; unknown → null
// (treated as "no stage requested" rather than writing garbage to Attio).
export function validStage(title) {
  const t = String(title || "").trim();
  return Object.prototype.hasOwnProperty.call(STAGE_RANK, t) ? t : null;
}

// Pull a deal's current stage title out of an Attio record's values.
function dealStageTitle(record) {
  const s = record?.values?.stage;
  const first = Array.isArray(s) ? s[0] : s;
  return first?.status?.title ?? first?.title ?? null;
}

// Should we move `current` → `requested`? Only when strictly forward.
export function isForwardStage(current, requested) {
  const c = STAGE_RANK[current] ?? 0;
  const r = STAGE_RANK[requested] ?? 0;
  return r > c;
}

// GHL's survey-trigger webhook nests custom data (secret, stage) under
// `customData` and sends contact fields at the top level under its own snake_case
// keys. Flatten so the handler can read everything from one object. Top-level
// keys win over customData on collision (shouldn't happen, but be deterministic).
export function flattenGhlBody(body) {
  const custom = (body && typeof body.customData === "object" && body.customData) || {};
  return { ...custom, ...body };
}

// GHL may send only `full_name` (no first/last). Attio's person name wants
// first/last, so split on the last space when first/last aren't provided.
export function splitName(fullName, firstName, lastName) {
  const full = String(fullName || "").trim();
  let first = String(firstName || "").trim();
  let last = String(lastName || "").trim();
  if (!first && !last && full) {
    const parts = full.split(/\s+/);
    first = parts.shift() || "";
    last = parts.join(" ");
  }
  return { first, last, full: full || [first, last].filter(Boolean).join(" ") };
}

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

// Look up the single deal carrying this unique ghl_contact_id. Returns
// { id, stage } so callers can make a forward-only stage decision, or null.
async function queryDealByContact(contactId) {
  const r = await attioFetch("POST", "/objects/deals/records/query", {
    filter: { ghl_contact_id: contactId },
    limit: 1,
  });
  if (!r.ok) {
    const err = new Error(`Deal query failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "Deal"; err.statusCode = r.status; throw err;
  }
  const rec = r.json?.data?.[0];
  if (!rec?.id?.record_id) return null;
  return { id: rec.id.record_id, stage: dealStageTitle(rec) };
}

// Create a brand-new deal. `stage` defaults to Lead but a STEP-2 ("Meeting
// Booked") call lands the deal at that stage directly if no Lead row existed
// yet (e.g. STEP 1 never fired or failed).
async function createDeal({ contactId, dealName, companyId, personId, stage }) {
  const values = {
    ghl_contact_id: contactId,
    name: dealName,
    stage: stage || DEAL_STAGE,
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

// Refresh an EXISTING deal. value/owner/source are NEVER touched — a refire,
// retry or replay must not reset them. Associations are backfilled if missing.
// Stage is moved ONLY forward: `requestedStage` advances the deal iff it ranks
// strictly higher than `currentStage` (so STEP 2 lifts a Lead to Meeting Booked,
// but a repeated STEP 2 reminder, or a deal the team moved to Quoted/Won, is
// left exactly where it is). If nothing changes, no PATCH is fired.
async function refreshDeal(recordId, { companyId, personId, currentStage, requestedStage }) {
  const values = {};
  if (companyId) values.associated_company = [{ target_object: "companies", target_record_id: companyId }];
  if (personId) values.associated_people = [{ target_object: "people", target_record_id: personId }];
  if (requestedStage && isForwardStage(currentStage, requestedStage)) {
    values.stage = requestedStage;
  }
  if (Object.keys(values).length === 0) return recordId;

  const r = await attioFetch("PATCH", `/objects/deals/records/${recordId}`, { data: { values } });
  if (!r.ok) {
    const err = new Error(`Deal update failed (${r.status}): ${r.raw?.slice(0, 300)}`);
    err.step = "Deal"; err.statusCode = r.status; throw err;
  }
  return recordId;
}

// Idempotent deal write keyed by the unique ghl_contact_id. The same GHL
// contact always maps to one deal (a returning lead updates it rather than
// spawning a duplicate); a refire must NOT overwrite live pipeline state — so
// we split create from update instead of a blind PUT-upsert:
//   - no existing deal → create at `stage` (default Lead)
//   - existing deal     → backfill associations + advance stage FORWARD-ONLY
//                          (value/owner/source always preserved)
// The query→create window is closed by Attio's uniqueness on ghl_contact_id:
// a racing second create hits a uniqueness conflict and we recover by
// re-querying and refreshing the winner — the same idiom as the person upsert.
async function upsertDeal({ contactId, dealName, companyId, personId, stage }) {
  const existing = await queryDealByContact(contactId);
  if (existing) {
    return refreshDeal(existing.id, { companyId, personId, currentStage: existing.stage, requestedStage: stage });
  }
  try {
    return await createDeal({ contactId, dealName, companyId, personId, stage });
  } catch (e) {
    if (isUniqueConflict(e)) {
      const requeried = await queryDealByContact(contactId);
      if (requeried) {
        return refreshDeal(requeried.id, { companyId, personId, currentStage: requeried.stage, requestedStage: stage });
      }
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
// Keyed by the GHL contact id, hashed to be RTDB-safe against `. # $ / [ ]`.
// Stores the raw payload for replay.
function logKey(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 24);
}

// `strict: true` makes the write throw on any failure (missing Firebase config
// OR a rejected patch). The Attio-failure path uses it: we only suppress GHL's
// retry (return 200) if we KNOW the lead is durably recorded for replay. If the
// log can't be written, the lead must not silently vanish — we surface the
// failure so the caller can let GHL retry instead.
async function writeLog(id, data, { strict = false } = {}) {
  const { err } = getAdmin();
  if (err) {
    if (strict) throw new Error(`Durable log unavailable: ${err}`);
    return; // best-effort: no Firebase configured — don't fail the lead
  }
  const path = `/ghlLeadSync/attempts/${logKey(id)}`;
  if (strict) {
    await adminPatch(path, data); // let it throw — caller decides retry policy
    return;
  }
  try { await adminPatch(path, data); } catch { /* best-effort */ }
}

// Attio rejects a duplicate unique value (e.g. a second person with the same
// email) — surfaced as 409 or a uniqueness message. We treat that as a
// recoverable race, not a hard failure.
export function isUniqueConflict(e) {
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

  // Auth stays the first gate. Pull the secret defensively — req.body may be a
  // string/array/undefined if a caller sends the wrong Content-Type and Vercel
  // doesn't JSON-parse it, so guard the property access. GHL's workflow webhook
  // nests custom data under `customData`, so accept the secret there too.
  const bodyIsObject = req.body && typeof req.body === "object" && !Array.isArray(req.body);
  const providedSecret =
    (bodyIsObject ? req.body.secret : undefined) ||
    (bodyIsObject && req.body.customData && typeof req.body.customData === "object" ? req.body.customData.secret : undefined) ||
    req.headers["x-ghl-secret"];
  if (providedSecret !== SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }

  // Reject a non-object body (wrong Content-Type, raw string, array) cleanly
  // instead of letting field extraction silently produce blanks and a confusing
  // 422 "missing fields".
  if (!bodyIsObject) {
    return res.status(400).json({ error: "Invalid body — expected a JSON object" });
  }
  // GHL nests custom data (secret/stage) under `customData` and sends contact
  // fields at the top level under its own keys — flatten to read uniformly.
  const body = flattenGhlBody(req.body);

  // Normalise inbound fields against GHL's native payload (snake_case) with
  // camelCase fallbacks so a future direct-mapped caller also works.
  const contactId = String(body.contact_id || body.contactId || body.opportunityId || "").trim();
  const email = String(body.email || "").trim();
  // Business/company name is OPTIONAL — GHL's survey trigger doesn't reliably
  // send one. If present we dedupe/create a company; if absent the lead still
  // becomes a Person + Deal, just without a company link.
  const businessName = String(body.company_name || body.businessName || body.business_name || "").trim();
  const phone = String(body.phone || "").trim();
  const { first: firstName, last: lastName, full: fullName } =
    splitName(body.full_name || body.fullName, body.first_name || body.firstName, body.last_name || body.lastName);
  // Optional per-workflow stage (from customData). STEP 1 sends nothing →
  // defaults to Lead on create. STEP 2 sends "Meeting Booked" → advances the
  // deal forward-only. Unknown values are ignored, never written.
  const requestedStage = validStage(body.stage);
  const dealName = businessName
    ? `${fullName || email || "Lead"} - ${businessName}`
    : (fullName || email || "Lead");

  // ── Phase 1.5 preflight hard-stop ──
  // GHL's survey webhook always carries a contact_id + email; if either is blank
  // the plumbing is broken (mis-nested customData, wrong trigger). A blank key
  // would collapse records — blank email overwrites one empty person, blank
  // contact id overwrites one empty deal — so stop rather than write junk.
  const missing = [];
  if (!contactId) missing.push("contact_id");
  if (!email) missing.push("email");
  if (missing.length) {
    await slackAlert(
      `🚨 GHL→Attio lead rejected — missing required field(s): *${missing.join(", ")}*\n`
      + `Email: ${email || "—"} · Contact ID: ${contactId || "—"}\n`
      + `_Check the GHL workflow webhook (secret/contact mapping)._`,
    );
    if (contactId) await writeLog(contactId, {
      contactId, status: "rejected", reason: `missing: ${missing.join(",")}`,
      payload: req.body, updatedAt: new Date().toISOString(),
    });
    return res.status(422).json({ ok: false, error: "Missing required field(s)", missing });
  }

  // Durable "pending" record up front so a mid-flight crash is still visible/replayable.
  await writeLog(contactId, {
    contactId, businessName, email, fullName, status: "pending",
    payload: req.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  let companyId = null, personId = null, dealId = null, companyStatus = null;
  try {
    // ── Phase 2: Company (only when a business name is present) ──
    if (businessName) {
      const company = await resolveCompany(businessName);
      companyStatus = company.status;
      companyId = company.companyId;
      if (company.status === "ambiguous") {
        const links = company.candidateIds.map(id => `<${companyUrl(id)}|${id}>`).join("  ·  ");
        await slackAlert(
          `⚠️ GHL→Attio: *${company.candidateIds.length}+ companies* match "${businessName}" — manual link needed.\n`
          + `Lead captured WITHOUT a company link (person + deal still created).\n`
          + `Candidates: ${links}\n`
          + `Contact: ${fullName} · ${email} · Contact ID: ${contactId}`,
        );
      }
    } else {
      companyStatus = "none";
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

    // ── Phase 4: Deal (upsert by unique ghl_contact_id) ──
    dealId = await upsertDeal({ contactId, dealName, companyId, personId, stage: requestedStage });

    await writeLog(contactId, {
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
      await writeLog(contactId, {
        contactId, businessName, email, fullName, payload: req.body,
        status: "failed", failedStep: step, statusCode,
        companyId, personId, dealId, error: e.message, updatedAt: new Date().toISOString(),
      }, { strict: true });
      logged = true;
    } catch (logErr) {
      console.error("ghl-lead-webhook: durable failure log FAILED:", logErr);
    }

    await slackAlert(
      `🚨 GHL→Attio sync failure — step: *${step}*${statusCode ? ` (HTTP ${statusCode})` : ""}\n`
      + `Contact: ${fullName} · Business: ${businessName || "—"} · Email: ${email}\n`
      + `Resolved so far: company=${companyId || "—"} person=${personId || "—"} deal=${dealId || "—"}\n`
      + `Error: ${e.message}\n`
      + `Contact ID: ${contactId} — ${logged ? "logged for replay." : "⚠️ DURABLE LOG FAILED — asking GHL to retry."}`,
    );

    if (logged) {
      // Durably recorded → suppress GHL retry-storm; we own the replay.
      return res.status(200).json({ ok: false, status: "failed", step, error: e.message });
    }
    // No durable record → let GHL retry rather than lose the lead silently.
    return res.status(502).json({ ok: false, status: "failed", step, error: e.message, durableLog: false });
  }
}
