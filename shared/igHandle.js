// Instagram handle normalisation — shared by the React UI (chip inputs)
// and the API (everywhere an Apify directUrl is built). One source of
// truth so a handle that passes the input box can never fail Apify's
// input regex later, and vice versa.
//
// Producers paste all kinds of things into handle fields: bare names,
// @names, profile URLs, reel/post permalinks, TikTok links. Only the
// first two-and-a-half of those contain an Instagram username; the rest
// must be rejected with a reason the UI can turn into a useful message
// instead of being smushed into https://www.instagram.com/<garbage>/.

// Instagram usernames: letters, digits, dots, underscores, max 30 chars.
const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

// First path segments that are Instagram features, not usernames.
// instagram.com/reels/<code> is a reel permalink; instagram.com/p/<code>
// is a post. A real profile URL has the username as its first segment.
const RESERVED_SEGMENTS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts",
  "direct", "share", "about", "legal", "developer", "web",
]);

/**
 * Parse any user-supplied competitor/client input into a canonical
 * Instagram handle.
 *
 * Returns { handle: "@username" } on success, or
 * { handle: null, reason } where reason is one of:
 *   "empty" | "tiktok" | "not_instagram" | "post_link" | "invalid_username"
 */
export function parseIgHandle(raw) {
  const input = String(raw || "").trim();
  if (!input) return { handle: null, reason: "empty" };

  // Chips in the wild carry shapes like "@https://www.instagram.com/x/"
  // — the @ was prepended around an already-pasted URL. Strip it before
  // deciding whether this is a URL.
  let s = input.replace(/^@+/, "").trim();
  if (!s) return { handle: null, reason: "empty" };

  // URL detection: explicit scheme, www., or bare domain + path.
  const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s);
  if (looksLikeUrl) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return { handle: null, reason: "invalid_username" };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return { handle: null, reason: "tiktok" };
    }
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) {
      return { handle: null, reason: "not_instagram" };
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return { handle: null, reason: "invalid_username" };
    const first = decodeURIComponent(segments[0]).replace(/^@+/, "");
    if (RESERVED_SEGMENTS.has(first.toLowerCase())) {
      return { handle: null, reason: "post_link" };
    }
    if (!IG_USERNAME_RE.test(first)) return { handle: null, reason: "invalid_username" };
    return { handle: `@${first.toLowerCase()}` };
  }

  // Plain text. Tolerate a trailing slash copied along with the name.
  s = s.replace(/\/+$/, "");
  if (!IG_USERNAME_RE.test(s)) return { handle: null, reason: "invalid_username" };
  return { handle: `@${s.toLowerCase()}` };
}

/**
 * Human-readable message for a parseIgHandle failure. Shared by the
 * inline input error in the UI and the API's 400 responses so producers
 * see the same wording everywhere.
 */
export function igHandleProblemText(reason) {
  switch (reason) {
    case "tiktok":
      return "TikTok links aren't supported here — competitor research scrapes Instagram only";
    case "post_link":
      return "that's a post/reel link, not a profile — paste the account's profile URL or @handle";
    case "not_instagram":
      return "only Instagram profile URLs or @handles work here";
    case "empty":
      return "add a handle first";
    default:
      return "doesn't look like an Instagram handle — use @name or the profile URL";
  }
}

/**
 * Validate a list of competitor records ({ handle, ... }) ahead of an
 * Apify scrape. Returns:
 *   cleaned — records with handle replaced by the canonical @username
 *             (deduped after normalisation; first occurrence wins)
 *   bad     — [{ handle, reason }] for every record that can't be
 *             normalised to an Instagram profile
 */
export function splitCompetitorsByValidity(competitors) {
  const cleaned = [];
  const bad = [];
  const seen = new Set();
  for (const c of competitors || []) {
    const rawHandle = c?.handle;
    if (!rawHandle) continue;
    const parsed = parseIgHandle(rawHandle);
    if (!parsed.handle) {
      bad.push({ handle: String(rawHandle), reason: parsed.reason });
      continue;
    }
    if (seen.has(parsed.handle)) continue;
    seen.add(parsed.handle);
    cleaned.push({ ...c, handle: parsed.handle });
  }
  return { cleaned, bad };
}

// One-line "what's wrong" summary for a list of bad entries — used in
// API error details and the Stage B pre-flight error. Long pasted URLs
// are truncated so the message stays readable.
export function describeBadHandles(bad) {
  return (bad || [])
    .map(b => {
      const shown = b.handle.length > 48 ? `${b.handle.slice(0, 45)}…` : b.handle;
      return `"${shown}" — ${igHandleProblemText(b.reason)}`;
    })
    .join(" · ");
}
