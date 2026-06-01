// shared/attio-extract.js
//
// Isomorphic helpers for reading the RAW Attio deal records that
// api/sync-attio-cache.js stores at /attioCache.data, plus the
// project -> Won-deal matcher the margin instrument uses to source each
// project's sold-for amount when /projects.dealValue is blank.
//
// WHY THIS EXISTS: projects created by api/webhook-deal-won.js carry
// `attioDealId: null` (the webhook never captured the deal's record_id)
// and only get a `dealValue` when the upstream automation happened to map
// it, so revenue is blank on most rows. Attio holds a clean `value` on
// every Won deal, already cached in Firebase. With no foreign key we match
// project -> deal by NAME (+ company to disambiguate). The match is
// ADDITIVE ONLY: it never overrides a value a project already has, and an
// ambiguous match returns NO number (flags the row) rather than guessing.
//
// MONEY-PARSING NOTE: extractVal/extractDate/extractStage intentionally
// mirror api/_attio-metrics.js byte-for-byte. They are duplicated, not
// imported, so the Founders north-star KPI path and this profitability
// path stay decoupled (a change to one must NOT silently move the other).
// Attio's value schema is stable; if you change a parser here, change it
// there too. Dependency-free so it runs under Node (cron) and in the
// browser bundle (live recompute) unchanged.

// --- raw-cell extractors (mirror api/_attio-metrics.js) ---

// Parse a currency cell to a number. Attio normally returns currency_value
// as a NUMBER, but a stringified / formatted money value ("A$3,695.00") must
// never be misread: a naive parseFloat("3,695.00") returns 3, which would
// attach a wildly wrong revenue while the row still looked "complete". Strip
// currency symbols + thousands separators first; a genuinely unparseable
// value becomes 0 (so the row flags "missing deal value" rather than
// guessing). Numbers pass through untouched.
// NOTE: this is STRICTER than api/_attio-metrics.js's extractVal, which still
// does the naive parseFloat. The two are otherwise mirrors; the divergence is
// intentional and money-safe (numeric inputs behave identically). The KPI
// path should get the same hardening separately.
function toMoney(n) {
  if (typeof n === "number") return Number.isFinite(n) ? n : 0;
  if (typeof n === "string") {
    const f = parseFloat(n.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(f) ? f : 0;
  }
  return 0;
}

// Attio nests every attribute as an array of cells; currency cells carry
// `currency_value` (or `value`), and orgs label the money field
// differently, so fall through a candidate list.
export function extractVal(d) {
  const v = d?.values || {};
  const candidates = [v.deal_value, v.amount, v.value, v.revenue, v.contract_value];
  for (const c of candidates) {
    if (c?.[0] != null) {
      const n = c[0].currency_value ?? c[0].value;
      if (n != null) return toMoney(n);
    }
  }
  return 0;
}

export function extractDate(d) {
  const v = d?.values || {};
  const candidates = [v.close_date, v.closed_at, v.won_date, v.created_at];
  for (const c of candidates) {
    if (c?.[0]?.value) return c[0].value;
  }
  return d?.created_at || null;
}

export function extractStage(d) {
  const v = d?.values || {};
  const candidates = [v.stage, v.status, v.deal_stage, v.pipeline_stage];
  for (const c of candidates) {
    const t = c?.[0]?.status?.title || c?.[0]?.value;
    if (t) return (typeof t === "string" ? t : "").toLowerCase();
  }
  return "";
}

// --- deal-specific extractors ---

// The deal's own name (NOT the company). Raw text cell: values.name[0].value.
export function extractDealName(d) {
  const v = d?.values || {};
  const candidates = [v.name, v.deal_name, v.title];
  for (const c of candidates) {
    const t = c?.[0]?.value;
    if (t && typeof t === "string") return t;
  }
  return "";
}

// The linked company's record_id (record-reference cell carries
// target_record_id). Lets us disambiguate two same-named deals by client.
export function extractDealCompanyId(d) {
  const v = d?.values || {};
  const ref = v.associated_company;
  const cell = Array.isArray(ref) ? ref[0] : ref;
  return cell?.target_record_id || cell?.record_id || null;
}

export function dealRecordId(d) {
  if (!d) return "";
  if (d.id?.record_id) return d.id.record_id;
  if (typeof d.id === "string") return d.id;
  return "";
}

// Stage is already lowercased by extractStage. Viewix's Attio deal pipeline
// has exactly ONE won state: "Won". Verified 2026-06-01 against the live
// `stage` attribute; the six stages are Lead, Meeting Booked, Quoted, On
// Hold, Won, Lost. So match the word "won" (a future rename to "Closed Won"
// still resolves) and reject an explicit negation so a compound like "Not
// Won" can't slip through. Erring toward FALSE is the safe bias: a missed
// match leaves a row "missing value" (honest), whereas a false positive
// attaches a non-won deal's revenue and silently inflates margin, the exact
// failure this instrument exists to avoid.
const WON_RE = /\bwon\b/;
const NOT_WON_RE = /\b(?:lost|not)\b/;
export function isWonStage(stage) {
  const s = String(stage || "");
  return WON_RE.test(s) && !NOT_WON_RE.test(s);
}

// Conservative name normaliser: trim, lowercase, collapse internal runs of
// whitespace. Deliberately does NOT strip punctuation — over-normalising
// would merge genuinely different deal names.
export function normName(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// --- matcher ---

// Index the Won deals in /attioCache by normalised name. Only Won deals
// with a positive value are indexed (a Lead/Lost deal isn't revenue, and a
// project only exists because its deal was Won). Returns { byName: Map }.
export function buildDealIndex(attioCache) {
  const deals = Array.isArray(attioCache?.data) ? attioCache.data : [];
  const byName = new Map();
  for (const d of deals) {
    if (!isWonStage(extractStage(d))) continue;
    const value = extractVal(d);
    if (!(value > 0)) continue;
    const recordId = dealRecordId(d);
    // No record id => we can't reference it OR dedupe it against another
    // project's claim (the double-count guard keys on dealId). Skip it
    // rather than index an unattributable deal.
    if (!recordId) continue;
    const name = normName(extractDealName(d));
    if (!name) continue;
    const entry = {
      recordId,
      value,
      companyId: extractDealCompanyId(d),
      closeDate: extractDate(d),
    };
    let arr = byName.get(name);
    if (!arr) { arr = []; byName.set(name, arr); }
    arr.push(entry);
  }
  return { byName };
}

// Resolve a project to its Won deal's value. CONFIDENT only when the match
// is unique by name (and not contradicted by company), or unique by name +
// company. A same-named deal that belongs to a DIFFERENT known company is
// rejected (value null, not ambiguous) — it's some other client's deal that
// merely shares a name. A genuine >1-way tie returns ambiguous so the caller
// flags the row instead of trusting a guessed number. Returns null when
// there is no candidate at all (caller then leaves the project's own value /
// missing-value handling).
export function resolveDealValue(project, dealIndex) {
  if (!dealIndex || !dealIndex.byName) return null;
  const key = normName(project?.projectName);
  if (!key) return null;
  const cands = dealIndex.byName.get(key);
  if (!cands || !cands.length) return null;
  const cid = project?.attioCompanyId || null;

  if (cands.length === 1) {
    const only = cands[0];
    // Single same-named deal is normally THE match — unless the project
    // knows its company and the deal's (known) company differs. Then this
    // is a name collision across clients: attach no number (a confident
    // wrong revenue is worse than none).
    if (cid && only.companyId && only.companyId !== cid) {
      return { value: null, dealId: null, ambiguous: false };
    }
    return { value: only.value, dealId: only.recordId, ambiguous: false };
  }

  // Multiple deals share this name — disambiguate by the project's company.
  if (cid) {
    const byCo = cands.filter((c) => c.companyId && c.companyId === cid);
    if (byCo.length === 1) {
      return { value: byCo[0].value, dealId: byCo[0].recordId, ambiguous: false };
    }
  }

  // Can't uniquely resolve — do NOT guess.
  return { value: null, dealId: null, ambiguous: true };
}
