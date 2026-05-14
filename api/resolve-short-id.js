// api/resolve-short-id.js
//
// Public-friendly endpoint that resolves a share-link shortId to its
// internal Firebase record id. Used by the three client-facing public
// views (deliveries, sales, preproduction) so they can fetch a single
// record by id instead of scanning the entire collection client-side.
//
// Pre-resolver model: `db.ref('/deliveries').once('value')` from an
// anonymous-authed session — both a perf bug and the data-disclosure
// vector that made every other delivery's metadata readable to anyone
// holding a single public link.
//
// Auth: deliberately none. ShortIds are part of the URL the visitor
// already has — requiring auth here adds no security. We rate-limit
// per IP to make enumeration attempts noisy. The Firebase rules then
// only need to grant per-record reads to anonymous, not collection
// reads.

import { getAdmin } from "./_fb-admin.js";

// `path` is the Firebase node holding records keyed by internal id;
// each record has a `shortId` leaf the rules expose via .indexOn.
const SUPPORTED_TYPES = {
  deliveries:    { path: "/deliveries" },
  sales:         { path: "/sales" },
  metaAds:       { path: "/preproduction/metaAds" },
  socialOrganic: { path: "/preproduction/socialOrganic" },
};

// Umbrella type — the preproduction public view doesn't know in
// advance whether a given shortId belongs to a Meta Ads research doc
// or a Social Organic one; resolver tries metaAds first, then social.
const PREPRODUCTION_TYPES = ["metaAds", "socialOrganic"];

// Per-instance rate limit. Leaky across Vercel cold starts but fine
// for a public lookup with strict input validation. Same shape as
// /api/auth.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const attempts = new Map();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  attempts.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ShortIds come from makeShortId (src/utils.js): 10 chars from
// [abcdefghijkmnpqrstuvwxyz23456789]. We accept 4-12 here to match
// the public-view regex and tolerate historical lengths.
function isValidShortId(s) {
  return typeof s === "string" && /^[a-z0-9]{4,12}$/i.test(s);
}

async function lookupOne(type, shortIdLower) {
  const { path } = SUPPORTED_TYPES[type];
  const { db, err } = getAdmin();
  if (err) throw new Error(err);
  const snap = await db.ref(path)
    .orderByChild("shortId")
    .equalTo(shortIdLower)
    .limitToFirst(1)
    .once("value");
  const val = snap.val();
  if (!val) return null;
  const [id] = Object.keys(val);
  return id || null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  if (!checkRate(clientIp(req))) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  const type = String(req.query?.type || "").trim();
  const shortIdRaw = String(req.query?.shortId || "").trim();
  if (!isValidShortId(shortIdRaw)) {
    return res.status(400).json({ error: "Invalid shortId" });
  }
  const shortId = shortIdRaw.toLowerCase();

  const typesToTry = type === "preproduction"
    ? PREPRODUCTION_TYPES
    : (SUPPORTED_TYPES[type] ? [type] : null);
  if (!typesToTry) return res.status(400).json({ error: "Invalid type" });

  try {
    for (const t of typesToTry) {
      const id = await lookupOne(t, shortId);
      if (id) return res.status(200).json({ id, type: t });
    }
    return res.status(404).json({ found: false });
  } catch (e) {
    console.error("resolve-short-id error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}
