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

// STRICT won-close date: the deal's actual close-date cell only
// (close_date / closed_at / won_date), or null. Deliberately does NOT fall back to
// created_at like extractDate — a deal's creation time is not proof of WHEN it was
// won. Used by resolveWonDealId to corroborate a weak name match: a stale same-named
// sibling created on the just-won deal's signing day must NOT pass corroboration via
// a coincidental created_at (it would stamp the wrong FK — the exact failure the
// corroboration exists to prevent).
export function extractCloseDateStrict(d) {
  const v = d?.values || {};
  const candidates = [v.close_date, v.closed_at, v.won_date];
  for (const c of candidates) {
    const cell = c?.[0];
    // date-typed Attio cells surface the day under `date`; timestamp cells under
    // `value`. Read both (still NO created_at fallback) so a date-typed close_date
    // can't silently fail corroboration and turn the name path into a no-op.
    const val = cell?.value || cell?.date;
    if (val) return val;
  }
  return null;
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

// All associated person record_ids on the deal, in Attio order. Where
// extractDealPersonId returns null for 0 or >1 (so the backfill never guesses a
// single contact), this exposes the full list so the carry-across backfill can
// DISTINGUISH a zero-person deal (nothing to fetch) from a multi-person deal
// (never auto-pick — surface for a human to choose) and stamp the project with
// the reason it can't self-heal.
export function extractDealPeopleIds(d) {
  const v = d?.values || {};
  const ref = v.associated_people;
  const arr = Array.isArray(ref) ? ref : (ref ? [ref] : []);
  const ids = arr
    .map((cell) => cell?.target_record_id || cell?.record_id || null)
    .filter(Boolean);
  // Dedupe: Attio can repeat the same person reference in the cell. A deal with
  // one real-but-duplicated contact must read as ONE person (so the backfill
  // heals it) rather than two (which would wrongly stamp blocked_multi).
  return [...new Set(ids)];
}

// --- person-record extractors (raw Attio person, fetched per-id) ---

// First email on a person record. Attio email cells carry `email_address`
// (fall through `value`). Returns null when the person has no email OR the
// value isn't email-shaped — a malformed Attio address must never be written
// as a client's send target (mirrors EMAIL_LIGHT in _email/getProjectContext.js).
export function extractPersonEmail(person) {
  const v = person?.values || {};
  const cell = Array.isArray(v.email_addresses) ? v.email_addresses[0] : v.email_addresses;
  const raw = cell?.email_address || cell?.value;
  const email = raw ? String(raw).trim() : "";
  return (email.includes("@") && email.length < 255) ? email : null;
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
      peopleIds: extractDealPeopleIds(d),
      companyId: extractDealCompanyId(d),
      closeDate: extractDate(d),
      // Strict won-close date (no created_at fallback) — only for win-event
      // corroboration in resolveWonDealId. See extractCloseDateStrict.
      wonCloseDate: extractCloseDateStrict(d),
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
//   { kind: "match", entry, via } confident match; via "fk" (deal id) or "name".
//                               resolveDealValue trusts ONLY via "fk" for revenue.
function matchDealEntry(project, dealIndex) {
  if (!dealIndex || !dealIndex.byName) return { kind: "none" };

  // FOREIGN-KEY FAST PATH (strongest signal, tried first). Projects created by
  // api/webhook-deal-won.js carry their won deal's Attio record id — it lands in
  // `attioCompanyId` because the Zapier payload mislabels the deal id as
  // companyId (attioDealId is never populated today; the proper upstream fix is
  // to populate attioDealId at the webhook, after which attioCompanyId can stop
  // doubling as a deal FK). A record-id hit IS the deal that created this
  // project: confident regardless of name edits, same-name collisions, or a
  // blank projectName. This rescued the company-guard rejections that were
  // zeroing ~16 real deal values (e.g. Masterton $6,517, Market Leader $18,888).
  //
  // Why a genuine company id in attioCompanyId won't false-match: Attio record
  // ids are workspace-unique UUIDs, so a company's id colliding with some deal's
  // id is a ~2^-122 event, not a contract guarantee — a real company id simply
  // misses byRecordId in practice and falls through to the name path below.
  //
  // `attioDealId || attioCompanyId` (NOT independent tries of both) is load-
  // bearing for safety. It encodes the field's lifecycle: TODAY attioDealId is
  // null and attioCompanyId carries the deal id, so attioCompanyId is used. Once
  // the upstream webhook fix populates attioDealId, THAT becomes authoritative
  // and attioCompanyId reverts to meaning a real company id. So when attioDealId
  // is present but misses the index (a Lost/uncached deal), we must NOT fall
  // back to attioCompanyId as a deal FK — doing so would attach an UNRELATED
  // cached deal's revenue and mark the row Complete with zero corroboration. The
  // `||` short-circuits to attioDealId, misses, and drops to the name path
  // (worst case a revenue MISS = Incomplete = safe), instead of a confident
  // wrong attach. (Codex round 2, Finding 1.)
  const fk = project?.attioDealId || project?.attioCompanyId || null;
  if (fk && dealIndex.byRecordId && dealIndex.byRecordId.has(fk)) {
    return { kind: "match", entry: dealIndex.byRecordId.get(fk), via: "fk" };
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
    return { kind: "match", entry: only, via: "name" };
  }

  // Multiple deals share this name — disambiguate by the project's company.
  if (cid) {
    const byCo = cands.filter((c) => c.companyId && c.companyId === cid);
    if (byCo.length === 1) return { kind: "match", entry: byCo[0], via: "name" };
  }

  // Can't uniquely resolve — do NOT guess.
  return { kind: "ambiguous" };
}

// Resolve a project to its Won deal's value — from the Attio deal ID (foreign
// key) ONLY. A name match is NOT trusted for revenue (see below), so it yields
// no value. Returns null when there is no candidate (or only a name match);
// { value:null, ambiguous } on a mismatch/tie; or { value, dealId } on a
// confident deal-id match.
export function resolveDealValue(project, dealIndex) {
  const m = matchDealEntry(project, dealIndex);
  switch (m.kind) {
    case "none":      return null;
    case "mismatch":  return { value: null, dealId: null, ambiguous: false };
    case "ambiguous": return { value: null, dealId: null, ambiguous: true };
    case "match":
      // Deal VALUE is sourced from the Attio deal ID (foreign key) ONLY. A name
      // match is too weak to attach revenue: generic project names ("Brand
      // Video", "Day in the life") collide across clients, so a single same-named
      // Won deal could be a DIFFERENT client's — attaching wrong revenue and
      // marking the row Complete (Codex round 3, HIGH). So a name match yields NO
      // value; the row stays Incomplete for manual entry. Name matching still
      // serves resolveDeal (contact / video-count backfill), where a wrong guess
      // is harmless. Founder's call: rely on the deal id, not the name.
      if (m.via !== "fk") return null;
      return { value: m.entry.value, dealId: m.entry.recordId, ambiguous: false };
    default:          return null;
  }
}

// Resolve a project to its full Won-deal entry for the carry-across backfill.
// Returns the matched index entry (carrying numberOfVideos + personId) on a
// confident match, an ambiguous flag on a tie, or null when there's no confident
// deal (no candidate OR a cross-client name collision). Never guesses.
export function resolveDeal(project, dealIndex) {
  const m = matchDealEntry(project, dealIndex);
  if (m.kind === "match")     return { entry: m.entry, dealId: m.entry.recordId, ambiguous: false, via: m.via };
  if (m.kind === "ambiguous") return { entry: null, dealId: null, ambiguous: true };
  return null; // none or mismatch -> no confident deal to backfill from
}

// Win-time foreign-key resolver for api/webhook-deal-won.js. Given the deal list
// just synced to /attioCache and the won deal's name + the payload's companyId,
// return the deal's Attio record_id to stamp as project.attioDealId — the strong
// FK the nightly contact backfill (sync-attio-cache.js) prefers over fragile name
// matching. Resolution mirrors resolveDeal: a record-id hit on companyId first
// (the Zapier payload maps the deal id into that field), else a confident
// name(+company) match. The webhook is the ideal moment to capture it: projectName
// still equals the deal name (so the name path resolves cleanly), and once stored
// the FK survives any later project-name edit that would break the nightly's name
// fallback — the exact failure that leaves projects un-emailable. Returns
// { dealId, via } on a confident match, { ambiguous: true } on a tie, or null when
// there is no confident deal. Never guesses: an ambiguous/absent match leaves the
// project FK-less so the nightly stamps blocked_ambiguous / blocked_no_deal.
export function resolveWonDealId(dealIndex, { dealName, companyId, closeDate } = {}) {
  const m = resolveDeal(
    { projectName: (dealName || "").trim(), attioCompanyId: companyId || null, attioDealId: null },
    dealIndex,
  );
  if (!m) return null;
  if (m.ambiguous) return { ambiguous: true };
  // A record-id (FK) hit on companyId IS this exact deal — definitive, stamp it.
  if (m.via === "fk") return { dealId: m.dealId, via: "fk" };
  // A NAME match is weaker proof: a unique same-name(+company) candidate can be a
  // STALE sibling of the just-won deal when the real one is missing from the synced
  // list — it sits past the 1000-deal cache cap, OR Attio read-after-write lag still
  // reports its pre-Won stage so buildDealIndex (Won-only) drops it, leaving an older
  // same-named Won deal as the lone candidate. A bare name match would then stamp the
  // WRONG deal id — wrong contact AND wrong revenue (attioDealId is the FK
  // resolveDealValue trusts). Corroborate with the deal's STRICT close date
  // (entry.wonCloseDate — close_date/closed_at/won_date only, NEVER the created_at
  // fallback, which a sibling created on the just-won deal's signing day would
  // otherwise satisfy): the just-won deal's close_date equals the payload's, a stale
  // sibling's does not. Stamp only when both are present and agree (date-only);
  // otherwise leave FK-less for the nightly to resolve — never guess.
  const wonDate = String(closeDate || "").slice(0, 10);
  const entryDate = String(m.entry?.wonCloseDate || "").slice(0, 10);
  if (wonDate && entryDate && wonDate === entryDate) return { dealId: m.dealId, via: "name" };
  return null;
}

// The deal record ids a project could be CLAIMING, for the double-count guard in
// computeProfitability — distinct from resolveDealValue (attaches a value, FK
// only) and resolveDeal (backfill, one confident match). Returns the FK id when
// it hits the index, else EVERY same-name Won-deal candidate. Counting every
// candidate makes an ambiguous cross-client name claim conservatively consume
// each deal it could be, so an FK sibling pointing at any of them is flagged
// instead of doubling the sale. Over-counting is safe: the guard only blocks a
// blank row's borrow (=> Incomplete), it never attaches a value.
export function resolveDealClaims(project, dealIndex) {
  if (!dealIndex || !dealIndex.byName) return [];
  const fk = project?.attioDealId || project?.attioCompanyId || null;
  if (fk && dealIndex.byRecordId && dealIndex.byRecordId.has(fk)) return [fk];
  const key = normName(project?.projectName);
  if (!key) return [];
  const cands = dealIndex.byName.get(key);
  if (!cands || !cands.length) return [];
  return cands.map((c) => c.recordId).filter(Boolean);
}

// Normalise a Zapier/Attio closeDate before it anchors a milestone
// chain (consumed by api/webhook-deal-won.js). Attio's API emits ISO
// 8601 (passes straight through), but a zap formatter can emit
// AU-style DD/MM/YYYY — new Date() then either yields Invalid Date
// (day > 12, which used to throw RangeError in the webhook's addDays
// and 500 the request before any record was written) or silently
// parses as the US month (day <= 12, wrong milestones with no error).
// Slash-dates are parsed explicitly as DD/MM; anything unparseable
// falls back to `today`.
export function normaliseCloseDate(raw, today) {
  if (!raw) return today;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw).trim());
  if (slash) {
    const [, d, m, y] = slash;
    const day = Number(d), month = Number(m), year = Number(y);
    // Round-trip component check — new Date("2026-04-31") OVERFLOW-
    // normalises to May 1 instead of going Invalid, so a NaN check
    // alone lets impossible calendar dates through as wrong dates.
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return today;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return Number.isNaN(new Date(raw).getTime()) ? today : raw;
}

// ─── Won-deal webhook dedup helpers ────────────────────────────────
// api/webhook-deal-won.js has no Zapier event id to dedupe on, so
// identity is normalised clientName+projectName. The key doubles as an
// RTDB path segment under /dealLocks — strip the characters RTDB
// forbids in keys (. # $ [ ] /) after normName (which deliberately
// keeps punctuation for name fidelity).
export function dealDedupKey(companyName, dealName) {
  const part = (s, fallback) =>
    normName(s || fallback).replace(/[.#$\[\]\/]/g, "_");
  return `${part(companyName, "unknown")}::${part(dealName, "Untitled project")}`;
}

// Find a recent (default 48h) non-archived project that the same
// won-deal webhook already created — Zapier timeout-replays and
// double-fired zaps re-send the same deal. createdAt is preferred;
// older records carry their creation time embedded in the
// `proj-<ms>-<rand>` id. A genuine same-name re-purchase months later
// is outside the window and goes through.
export function findRecentDuplicateProject(projects, { companyName, dealName, nowMs, windowMs = 48 * 60 * 60 * 1000 } = {}) {
  const key = dealDedupKey(companyName, dealName);
  for (const p of Object.values(projects || {})) {
    if (!p || !p.id || p.status === "archived") continue;
    if (dealDedupKey(p.clientName, p.projectName) !== key) continue;
    const fromId = Number((String(p.id).match(/^proj-(\d+)-/) || [])[1]) || 0;
    const created = Date.parse(p.createdAt || "") || fromId;
    if (created && nowMs - created <= windowMs) return p;
  }
  return null;
}
