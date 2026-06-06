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

// Parse a raw "number of videos" value into a clean integer count. Used both
// for the Zapier webhook payload (where it may arrive as "5", "5 videos", 5, or
// absent) AND the cron backfill. Rules:
//   - absent / "" / non-numeric  -> null (the field stays "missing", honest)
//   - else                       -> integer, floored, clamped to 0..500
// Preserves an explicit 0 (footage-only deals are legitimately 0 videos) —
// unlike the old `parseInt(x) || null`, which collapsed 0 to null. The 500
// ceiling is a safety cap so no single payload can drive a runaway placeholder
// loop (real-world max observed is 96).
export function parseVideoCount(raw) {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw).replace(/[^0-9.\-]/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(500, Math.max(0, Math.trunc(n)));
}

// Read `number_of_videos` from a RAW Attio deal record (number attribute:
// values.number_of_videos[0].value). Returns an integer incl. 0, or null when
// the attribute is absent — so the backfill can distinguish a real 0 from a
// deal that simply never had the field set.
export function extractNumberOfVideos(d) {
  const v = d?.values || {};
  const cell = Array.isArray(v.number_of_videos) ? v.number_of_videos[0] : v.number_of_videos;
  const raw = cell?.value;
  if (raw == null) return null;
  return parseVideoCount(raw);
}

// The deal's single associated person record_id (record-reference cell). Returns
// the id ONLY when there is exactly ONE associated person — zero or >1 returns
// null so the clientContact backfill never guesses which contact to email.
export function extractDealPersonId(d) {
  const v = d?.values || {};
  const ref = v.associated_people;
  const arr = Array.isArray(ref) ? ref : (ref ? [ref] : []);
  if (arr.length !== 1) return null;
  const cell = arr[0];
  return cell?.target_record_id || cell?.record_id || null;
}

// --- person-record extractors (raw Attio person, fetched per-id) ---

// First email on a person record. Attio email cells carry `email_address`
// (fall through `value`). Returns null when the person has no email.
export function extractPersonEmail(person) {
  const v = person?.values || {};
  const cell = Array.isArray(v.email_addresses) ? v.email_addresses[0] : v.email_addresses;
  const email = cell?.email_address || cell?.value;
  return email ? String(email).trim() : null;
}

// First name from a person record. Attio personal-name cells carry `first_name`
// + `full_name`. Falls back to the first whitespace-delimited token of full_name
// (mononym => whole name). Returns null when absent.
export function extractPersonFirstName(person) {
  const v = person?.values || {};
  const cell = Array.isArray(v.name) ? v.name[0] : v.name;
  if (!cell) return null;
  const first = cell.first_name && String(cell.first_name).trim();
  if (first) return first;
  const full = (cell.full_name || cell.value || "").toString().trim();
  if (!full) return null;
  return full.split(/\s+/)[0];
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

// Index the Won deals in /attioCache by normalised name. By default only Won
// deals with a POSITIVE value are indexed (a Lead/Lost deal isn't revenue, and
// the profitability instrument only cares about deals that carry a sale).
//
// `includeZeroValue: true` (used by the carry-across backfill) indexes EVERY Won
// deal with a record id regardless of value, because numberOfVideos / client
// contact must be recoverable even from a $0 (footage-only) Won deal. Each entry
// carries `numberOfVideos` + `personId` so the backfill can read them without a
// second pass over the raw cache.
//
// Returns { byName: Map, byRecordId: Map }. byRecordId is the FOREIGN-KEY index:
// projects created by api/webhook-deal-won.js carry the won deal's record id (it
// lands in the project's `attioCompanyId` field — the Zapier payload maps the
// deal id there, NOT the company id; see matchDealEntry). Matching on that id is
// far stronger than name matching: it is the exact deal that created the project,
// immune to name edits and same-name collisions. Nameless deals are still indexed
// here (id-match needs no name), so byRecordId is a superset of byName's records.
export function buildDealIndex(attioCache, { includeZeroValue = false } = {}) {
  const deals = Array.isArray(attioCache?.data) ? attioCache.data : [];
  const byName = new Map();
  const byRecordId = new Map();
  const seen = new Set();
  for (const d of deals) {
    if (!isWonStage(extractStage(d))) continue;
    const value = extractVal(d);
    if (!includeZeroValue && !(value > 0)) continue;
    const recordId = dealRecordId(d);
    // No record id => we can't reference it OR dedupe it against another
    // project's claim (the double-count guard keys on dealId). Skip it
    // rather than index an unattributable deal.
    if (!recordId) continue;
    // The cache can hold the SAME deal record twice (a pagination overlap in
    // api/sync-attio-cache.js, which pages by offset over created_at-desc
    // results). Index each record id once so one real deal can't masquerade
    // as a multi-candidate tie that resolveDealValue would flag ambiguous —
    // a genuine collision across DIFFERENT record ids still keeps both.
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    const entry = {
      recordId,
      value,
      numberOfVideos: extractNumberOfVideos(d),
      personId: extractDealPersonId(d),
      companyId: extractDealCompanyId(d),
      closeDate: extractDate(d),
    };
    // Index by record id first — a confident foreign key even for a deal whose
    // name is blank (which the byName index below would drop).
    byRecordId.set(recordId, entry);
    const name = normName(extractDealName(d));
    if (!name) continue;
    let arr = byName.get(name);
    if (!arr) { arr = []; byName.set(name, arr); }
    arr.push(entry);
  }
  return { byName, byRecordId };
}

// Core matcher shared by resolveDealValue + resolveDeal. CONFIDENT only when the
// match is unique by name (and not contradicted by company), or unique by name +
// company. Returns a tagged result:
//   { kind: "none" }            no index / blank name / no candidates
//   { kind: "mismatch" }        single candidate whose KNOWN company disagrees
//   { kind: "ambiguous" }       >1 candidate that company can't disambiguate
//   { kind: "match", entry }    confident single match
function matchDealEntry(project, dealIndex) {
  if (!dealIndex || !dealIndex.byName) return { kind: "none" };

  // FOREIGN-KEY FAST PATH (strongest signal, tried first). Projects created by
  // api/webhook-deal-won.js carry their won deal's Attio record id — it lands in
  // `attioCompanyId` because the Zapier payload mislabels the deal id as
  // companyId (attioDealId is never populated; checked first anyway for when the
  // upstream mapping is fixed). A record-id hit IS the deal that created this
  // project: confident regardless of name edits, same-name collisions, or a
  // blank projectName. SAFE because a genuine company id can never collide with
  // a deal record id — Attio keeps deal and company record ids in separate
  // spaces — so a true company id simply misses byRecordId and falls through to
  // the name path below. This rescued the company-guard rejections that were
  // zeroing ~16 real deal values (e.g. Masterton $6,517, Market Leader $18,888).
  const fk = project?.attioDealId || project?.attioCompanyId || null;
  if (fk && dealIndex.byRecordId && dealIndex.byRecordId.has(fk)) {
    return { kind: "match", entry: dealIndex.byRecordId.get(fk) };
  }

  const key = normName(project?.projectName);
  if (!key) return { kind: "none" };
  const cands = dealIndex.byName.get(key);
  if (!cands || !cands.length) return { kind: "none" };
  const cid = project?.attioCompanyId || null;

  if (cands.length === 1) {
    const only = cands[0];
    // Single same-named deal is normally THE match — unless the project knows
    // its company and the deal's (known) company differs. Then it's a
    // cross-client name collision: refuse (a confident wrong match is worse).
    if (cid && only.companyId && only.companyId !== cid) return { kind: "mismatch" };
    return { kind: "match", entry: only };
  }

  // Multiple deals share this name — disambiguate by the project's company.
  if (cid) {
    const byCo = cands.filter((c) => c.companyId && c.companyId === cid);
    if (byCo.length === 1) return { kind: "match", entry: byCo[0] };
  }

  // Can't uniquely resolve — do NOT guess.
  return { kind: "ambiguous" };
}

// Resolve a project to its Won deal's value. Returns null when there is no
// candidate at all (caller then leaves the project's own value / missing-value
// handling); an object with value:null + ambiguous flag on a mismatch/tie; or
// the value + dealId on a confident match. Contract unchanged from the original
// (profitability.js depends on it byte-for-byte).
export function resolveDealValue(project, dealIndex) {
  const m = matchDealEntry(project, dealIndex);
  switch (m.kind) {
    case "none":      return null;
    case "mismatch":  return { value: null, dealId: null, ambiguous: false };
    case "ambiguous": return { value: null, dealId: null, ambiguous: true };
    default:          return { value: m.entry.value, dealId: m.entry.recordId, ambiguous: false };
  }
}

// Resolve a project to its full Won-deal entry for the carry-across backfill.
// Returns the matched index entry (carrying numberOfVideos + personId) on a
// confident match, an ambiguous flag on a tie, or null when there's no confident
// deal (no candidate OR a cross-client name collision). Never guesses.
export function resolveDeal(project, dealIndex) {
  const m = matchDealEntry(project, dealIndex);
  if (m.kind === "match")     return { entry: m.entry, dealId: m.entry.recordId, ambiguous: false };
  if (m.kind === "ambiguous") return { entry: null, dealId: null, ambiguous: true };
  return null; // none or mismatch -> no confident deal to backfill from
}
