// middleware.js — Vercel Edge Middleware, root path only.
//
// Why this exists: Vercel resolves "/" against the filesystem
// (dist/index.html — the dashboard) BEFORE consulting vercel.json
// rewrites, so the host-scoped rewrite that routes viewixreviews.com.au
// to /reviews.html fires on every path EXCEPT the bare root — the
// single most-visited URL on the domain. Middleware runs before the
// filesystem, closing exactly that gap. (Discovered post-launch
// 2026-06-12; see docs/plans/viewix-reviews-site-scope-packet.md.)
//
// The matcher pins this to "/" only — dashboard assets, /api/*, and
// every deep path never invoke it. Deep-path routing stays in
// vercel.json (verified working: /r/x on the reviews host serves the
// reviews page; www deep paths 308 to apex).

export const config = { matcher: "/" };

export const REVIEWS_APEX = "viewixreviews.com.au";

// Pure decision function, unit-tested by api/__tests__/reviews-sync.test.mjs.
// Returns { action: "redirect", location } | { action: "rewrite", pathname }
// | { action: "next" }.
export function rootRouteFor(host) {
  const h = String(host || "").toLowerCase().split(":")[0];
  if (h === `www.${REVIEWS_APEX}`) {
    return { action: "redirect", location: `https://${REVIEWS_APEX}/` };
  }
  if (h === REVIEWS_APEX) {
    return { action: "rewrite", pathname: "/reviews.html" };
  }
  return { action: "next" };
}

export default function middleware(req) {
  const route = rootRouteFor(req.headers.get("host"));
  if (route.action === "redirect") {
    return Response.redirect(route.location, 308);
  }
  if (route.action === "rewrite") {
    const url = new URL(req.url);
    url.pathname = route.pathname;
    // x-middleware-rewrite is the documented header @vercel/edge's
    // rewrite() helper emits — used directly to avoid a dependency.
    return new Response(null, { headers: { "x-middleware-rewrite": url.toString() } });
  }
  // Dashboard root (planner.viewix.com.au etc.): continue to filesystem.
  return undefined;
}
