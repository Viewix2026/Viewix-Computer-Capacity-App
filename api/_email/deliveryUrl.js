// api/_email/deliveryUrl.js
// Server-safe delivery URL helper.
//
// `src/utils.js#deliveryShareUrl()` reads `window.location.origin`,
// which doesn't exist in a Vercel serverless function. Importing
// that helper into `/api/` would break every email send. This file
// duplicates the URL construction with a server-safe origin from
// `PUBLIC_BASE_URL` (e.g. https://planner.viewix.com.au).
//
// The pattern matches the existing rewrite in vercel.json:
//   /d/:rest*  ->  /index.html
// so URLs like `https://planner.viewix.com.au/d/abc123/acme-launch`
// route to the dashboard's delivery view.
//
// If `PUBLIC_BASE_URL` is missing, returns null. The calling email
// handler should treat that as a guard — Slack-log and skip rather
// than send an email with a broken or relative link.

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Build the public delivery URL from a delivery record.
 * @param {object} delivery - Firebase delivery record
 * @returns {string|null}   - https URL, or null if base URL or shortId is missing
 */
export function buildDeliveryUrl(delivery) {
  if (!delivery) return null;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  if (!delivery.shortId) {
    // Legacy fallback: ?d=ID. Still usable but uglier in email.
    if (delivery.id) return `${base}/?d=${delivery.id}`;
    return null;
  }
  const slug = slugify(`${delivery.clientName || ""} ${delivery.projectName || ""}`);
  return `${base}/d/${delivery.shortId}${slug ? "/" + slug : ""}`;
}
