// api/public/reviews.js
//
// PUBLIC (unauthenticated) review feed for viewixreviews.com.au.
// Same firewall pattern as delivery-am.js: the browser never reads
// RTDB — this endpoint reads /reviewsSite via the Admin SDK and
// returns only the curated card fields. Edge-cached for an hour;
// the wall tolerates staleness (reviews change weekly at most).
//
// Contract:  GET /api/public/reviews
// Returns:   { hasData: true,
//              meta: { rating, count, lastSyncAt },
//              reviews: [{ authorDisplayName, rating, text, createdAt }] }
//         or { hasData: false }  before the first successful sync.
//
// Tombstoned reviews (deletedAt set — review removed on Google) are
// excluded. ownerReply is intentionally NOT served: the design keeps
// cards pure client voice (see chats in the design hand-off bundle).

import { adminGet } from "../_fb-admin.js";
import { liveReviews } from "../_reviewsSync.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const site = await adminGet("/reviewsSite");
    const live = liveReviews(site?.reviews);

    if (!site?.meta?.lastSyncAt || live.length === 0) {
      // Pre-launch / empty state. Short cache so the first sync shows
      // up quickly instead of pinning "no data" for an hour.
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json({ hasData: false });
    }

    const reviews = live
      .map((r) => ({
        authorDisplayName: r.authorDisplayName,
        rating: r.rating,
        text: r.text || "",
        createdAt: r.createdAt,
      }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      hasData: true,
      meta: {
        rating: site.meta.rating,
        count: site.meta.count,
        lastSyncAt: site.meta.lastSyncAt,
      },
      reviews,
    });
  } catch (e) {
    console.error("[public/reviews]", e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Internal error" });
  }
}
